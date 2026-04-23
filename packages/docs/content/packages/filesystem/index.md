# agentlayer-filesystem

The filesystem package provides Node.js-based implementations of the core tool interfaces, plus hooks and toolset factories for building coding agents.

## Installation

```bash
bun add @humanlayer/agentlayer-filesystem
```

## What's Included

| Category | Description |
|----------|-------------|
| [Tools](./tools) | Individual tool factories (`createReadTool`, `createBashTool`, etc.) |
| [Toolsets](./toolsets) | Complete toolset factories for Claude/Codex agents |
| [Skills](./skills) | Skill loading from markdown files |
| [Subagents](./subagents) | Pre-configured coding subagent factory |
| [Hooks](./hooks) | File tracking, wasted read detection, output truncation |

## Quick Example

```ts
import {
  createClaudeCodingAgentToolset,
  createAgentSystemPrompt,
  createAgentFilesystemHooks
} from '@humanlayer/agentlayer-filesystem'
import { Agent } from '@humanlayer/agentlayer-core'

const cwd = process.cwd()

// Create tools, prompts, and hooks
const tools = await createClaudeCodingAgentToolset({ cwd })
const system = await createAgentSystemPrompt({ cwd, model: 'claude' })
const hooks = createAgentFilesystemHooks({ cwd })

const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools,
  system,
  hooks
})

for await (const event of agent.run('List the files in src/')) {
  console.log(event)
}
```

## Entry Points

```ts
// Main - everything
import { ... } from '@humanlayer/agentlayer-filesystem'

// Just prompts
import { ... } from '@humanlayer/agentlayer-filesystem/prompts'

// Just hooks
import { ... } from '@humanlayer/agentlayer-filesystem/hooks'
```

## Relationship to agentlayer-core

This package implements the tool interfaces defined in `agentlayer-core/interfaces`:

| Core Interface | Filesystem Implementation |
|---------------|--------------------------|
| `ReadTool` | `createReadTool()` |
| `WriteTool` | `createWriteTool()` |
| `EditTool` | `createEditTool()` |
| `BashTool` | `createBashTool()` |
| `GlobTool` | `createGlobTool()` |
| `GrepTool` | `createGrepTool()` |
| `ListTool` | `createListTool()` |
| `ApplyPatchTool` | `createApplyPatchTool()` |
| `WebSearchTool` | `createWebSearchTool()` |

The core package defines **what** tools do; this package provides **how** they do it on a Node.js filesystem.
