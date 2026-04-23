---
title: Subagents
description: Delegate work to specialized child agents with nested pause, resume, and state management.
---

# Subagents

Sub-agents let one agent delegate work to another through a normal tool call. They're useful for:

- **Context firewalls** — Keep sub-agent conversations isolated from the parent
- **Specialized expertise** — Give different tools to different agents
- **Resumable delegation** — Pause and resume at any nesting depth

## Quick Start

```ts
import { Agent, createSubagentsTool, startState } from '@humanlayer/agentlayer-core'
import { createReadTool, createGrepTool, createBashTool } from '@humanlayer/agentlayer-filesystem/tools'

// Create specialized child agents
const researchAgent = new Agent({
  model,
  system: 'You research code and explain findings.',
  tools: {
    read: createReadTool(),
    grep: createGrepTool(),
  },
})

const bashAgent = new Agent({
  model,
  system: 'You run shell commands.',
  tools: {
    bash: createBashTool({ cwd: process.cwd() }),
  },
})

// Create the subagent tool
const subagent = createSubagentsTool({
  agents: [
    {
      name: 'researcher',
      description: 'Investigates code and explains findings.',
      agent: researchAgent,
    },
    {
      name: 'bash',
      description: 'Runs shell commands.',
      agent: bashAgent,
    },
  ],
})

// Create parent agent with subagent tool
const parentAgent = new Agent({
  model,
  system: 'You coordinate work using specialist agents.',
  tools: { subagent },
})

const run = parentAgent.run({
  state: startState([{ role: 'user', content: 'Find all TODO comments in the codebase.' }]),
})
```

## How It Works

When the parent model calls the `subagent` tool:

1. The tool looks up the child by `subagent_type`
2. Creates or reloads the child's state
3. Runs the child agent
4. Waits for completion or pause
5. Returns the child's result to the parent

The parent sees the result as a normal tool output:

```xml
<agent_result>
I found 15 TODO comments across 8 files. Here's a summary...
</agent_result>
```

### Tool Input Schema

```ts
{
  description: string     // Short summary of the task
  prompt: string          // Instructions for the child
  subagent_type: string   // Which child to use ('researcher', 'bash', etc.)
  task_id?: string        // For resumable children only
}
```

::: info Source Reference
[`createSubagentsTool()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/src/tools/subagent.ts) in `subagent.ts`
:::

## Default vs Resumable Children

**Both modes** serialize child state to `state.subAgents` when a child pauses for approval. This is how pause/resume works for all sub-agents.

The difference is what happens after a child **completes**:

| Mode | After Completion | Next Call |
|------|------------------|-----------|
| Default | State discarded | Starts fresh |
| `resumable: true` | State stored in `toolState.subagents` | Can continue via `task_id` |

### Default Mode

```ts
const subagent = createSubagentsTool({
  agents: [
    {
      name: 'researcher',
      description: 'Investigates code.',
      agent: researchAgent,
      // No 'resumable' flag — default mode
    },
  ],
})
```

Each call starts a fresh conversation. If the child pauses for approval, its state is stored in `state.subAgents` and the parent can resume after approval is granted.

### Resumable Mode

::: warning Experimental
The `resumable: true` feature is not well tested. The pause/resume flow (via `state.subAgents`) is thoroughly tested, but the `task_id` continuation flow is not.
:::

```ts
const subagent = createSubagentsTool({
  agents: [
    {
      name: 'planner',
      description: 'Maintains a planning thread.',
      agent: plannerAgent,
      resumable: true,
    },
  ],
})
```

With resumable children:
- After completion, state is stored in `toolState.subagents`
- Later calls can pass `task_id` to continue the same conversation
- New prompts are appended as user messages to the stored state

## State Layout

Sub-agent state can live in two places:

### `state.subAgents` — Paused Children (Both Modes)

When **any** child pauses for approval, its state is stored here:

```ts
{
  messages: [...],
  pendingToolCalls: [
    { type: 'subAgent', toolCallId: 'xyz', agentId: 'researcher-1', ... }
  ],
  subAgents: {
    'researcher-1': {
      messages: [...],
      pendingToolCalls: [
        { type: 'approval', toolCallId: 'abc', ... }
      ]
    }
  }
}
```

This is the mechanism that makes nested pause/resume work. It applies to both default and resumable children.

### `state.toolState.subagents` — Completed Resumable Sessions

Only for `resumable: true` children after they complete:

```ts
{
  toolState: {
    subagents: {
      'planner-task-1': {
        messages: [...],  // Full conversation history
      }
    }
  }
}
```

This allows continuing a named session via `task_id`.

## Pause and Resume

Sub-agents integrate with the standard approval flow.

### When a Child Pauses

1. Child hits an approval hook that returns `ask()`
2. Child run finishes with `approvalRequired`
3. Parent's subagent tool returns a pause sentinel
4. Parent stores child state in `state.subAgents`
5. Parent finishes with `approvalRequired`

### Resuming

Use `getAllPendingApprovals()` to find all pending approvals, then apply them:

```ts
// Get all pending approvals (including nested)
const pending = getAllPendingApprovals(state)

// Apply approval
const resumed = withApprovals(state, [
  { toolCallId: pending[0].pending.toolCallId, approved: true },
])

// Resume parent — child will automatically resume
const run = parentAgent.run({ state: resumed })
```

`getAllPendingApprovals()` walks the entire tree, so you don't need separate code for parent vs child approvals.

::: info Source Reference
Test coverage: [`grandchild approval test`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-core/test/subagent-tool.test.ts)
:::

## Nested Subagents (N-Depth)

There's no depth limit. Any child can have its own subagent tool:

```ts
// Grandchild agent
const grandchildAgent = new Agent({
  model,
  tools: { read: createReadTool() },
})

// Child agent with its own subagent tool
const childAgent = new Agent({
  model,
  tools: {
    subagent: createSubagentsTool({
      agents: [{ name: 'deep-worker', agent: grandchildAgent, description: '...' }],
    }),
  },
})

// Parent agent
const parentAgent = new Agent({
  model,
  tools: {
    subagent: createSubagentsTool({
      agents: [{ name: 'child', agent: childAgent, description: '...' }],
    }),
  },
})
```

Depth is controlled by composition: each agent decides which children (if any) have sub-agent access.

## Event Streaming

Sub-agent events flow through to the parent's event stream with additional context:

```ts
const run = parentAgent.run({ state, stream: true })

for await (const event of run) {
  if (event.agentId) {
    // This event came from a child
    console.log(`From ${event.agentId}:`, event.type)
  }
  if (event.parentToolCallId) {
    // Can trace back to which subagent call
    console.log(`Parent call: ${event.parentToolCallId}`)
  }
}
```

Useful for UIs that want a merged stream while preserving structure.

## Design Patterns

### Narrow Tool Sets

Give each specialist only the tools it needs:

```ts
// Research agent: read-only
const researcher = new Agent({
  tools: { read: createReadTool(), grep: createGrepTool() },
})

// Writer agent: read + write
const writer = new Agent({
  tools: { read: createReadTool(), write: createWriteTool(), edit: createEditTool() },
})

// Bash agent: shell access
const runner = new Agent({
  tools: { bash: createBashTool() },
})
```

### Shared Hooks

Apply shared hooks before creating children:

```ts
import { createAgentFilesystemHooks } from '@humanlayer/agentlayer-filesystem'

const sharedHooks = createAgentFilesystemHooks({
  cwd: process.cwd(),
  outputTruncation: {
    maxLines: 500,
    maxBytes: 50000,
  },
})

const researcher = new Agent({
  model,
  tools: { ... },
  hooks: sharedHooks,
})

const writer = new Agent({
  model,
  tools: { ... },
  hooks: sharedHooks,
})
```

### Explicit Depth Control

Control depth by deciding which agents have subagent access:

```ts
// Leaf agent — no subagent tool
const leafAgent = new Agent({
  tools: { read: createReadTool() },
})

// Mid-level agent — can call leaf agents
const midAgent = new Agent({
  tools: {
    subagent: createSubagentsTool({
      agents: [{ name: 'leaf', agent: leafAgent, description: '...' }],
    }),
  },
})

// Root agent — can call mid-level agents
const rootAgent = new Agent({
  tools: {
    subagent: createSubagentsTool({
      agents: [{ name: 'mid', agent: midAgent, description: '...' }],
    }),
  },
})
```

## Real-World Example

Here's a pattern from `@humanlayer/agentlayer-filesystem`:

```ts
import { Agent, createSubagentsTool } from '@humanlayer/agentlayer-core'

// Create specialist agents
const codebaseLocator = new Agent({
  model,
  system: 'You find relevant files in the codebase.',
  tools: { grep, glob, list },
})

const codebaseAnalyzer = new Agent({
  model,
  system: 'You analyze code and explain implementation details.',
  tools: { read, grep },
})

const patternFinder = new Agent({
  model,
  system: 'You find similar implementations and usage examples.',
  tools: { read, grep, glob },
})

const webResearcher = new Agent({
  model,
  system: 'You research technical topics on the web.',
  tools: { webSearch, webFetch },
})

// Compose into one tool
const subagent = createSubagentsTool({
  agents: [
    { name: 'codebase-locator', description: 'Find files and directories', agent: codebaseLocator },
    { name: 'codebase-analyzer', description: 'Analyze code details', agent: codebaseAnalyzer },
    { name: 'pattern-finder', description: 'Find similar code', agent: patternFinder },
    { name: 'web-researcher', description: 'Research online', agent: webResearcher },
  ],
})

// Main coding agent
const codingAgent = new Agent({
  model,
  system: 'You are a coding assistant with access to specialists.',
  tools: {
    subagent,
    read: createReadTool(),
    write: createWriteTool(),
    edit: createEditTool(),
    bash: createBashTool(),
  },
})
```

::: info Source Reference
[`createCodingSubagentTool()`](https://github.com/humanlayer/agentlayer/blob/main/packages/agentlayer-filesystem/src/coding-agent.ts) in `coding-agent.ts`
:::

## Next Steps

- **[State](/concepts/state)** — How sub-agent state nests and persists
- **[Hooks](/concepts/hooks)** — Approval hooks that trigger pause
- **[Run API](/concepts/run-api)** — Resume patterns for nested approvals
