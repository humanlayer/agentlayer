# Subagents

The filesystem package provides a pre-configured subagent factory with specialized coding agents.

## createCodingSubagentTool()

Creates a subagent tool with multiple specialized agent types.

```ts
import { createCodingSubagentTool } from '@humanlayer/agentlayer-filesystem'

const agentTool = await createCodingSubagentTool({
  cwd: process.cwd(),
  model: 'claude-sonnet-4-20250514',
  onChildEvent: (event) => console.log('Subagent:', event)
})
```

## Available Agent Types

The tool includes these pre-configured specialist agents:

| Type | Description |
|------|-------------|
| `general-purpose` | General coding tasks, research, multi-step operations |
| `bash-specialist` | Focused on shell commands and system operations |
| `codebase-analyzer` | Analyzes implementation details and patterns |
| `codebase-locator` | Finds files and directories relevant to a task |
| `pattern-finder` | Finds similar implementations and usage examples |
| `implementer` | Follows implementation plans phase by phase |
| `web-researcher` | Searches the web for information |
| `library-researcher` | Researches library documentation |

## Usage

Agents can spawn subagents for specialized tasks:

```ts
// In a hook or tool
const result = await context.runSubagent({
  type: 'codebase-analyzer',
  prompt: 'Analyze the authentication flow in src/auth/'
})
```

## Options

```ts
interface CreateCodingSubagentToolOptions {
  cwd: string
  model: string
  
  // Optional system prompt customization
  system?: string | string[]
  systemPromptAdditions?: string[]
  
  // Hooks for subagents
  hooks?: {
    approval?: ApprovalHook[]
    preToolUse?: PreToolUseHook[]
    postToolUse?: PostToolUseHook[]
    preRequest?: PreRequestHook[]
  }
  
  // Stop conditions
  stopWhen?: StopConditionDef[]
  
  // Provider options
  providerOptions?: ProviderOptions
  
  // Event handling
  onChildEvent?: (event: AgentEvent) => void
  
  // Skill configuration
  skillDirs?: string[]
  skills?: Skill[]
  
  // Web tools
  exaApiKey?: string
  context7ApiKey?: string
}
```

## Including in Toolsets

Subagents are automatically included when using `createClaudeCodingAgentToolset`:

```ts
import { createClaudeCodingAgentToolset } from '@humanlayer/agentlayer-filesystem'

const tools = await createClaudeCodingAgentToolset({
  cwd: process.cwd(),
  // Subagents automatically configured
})
```

Or provide a custom subagent tool:

```ts
import {
  createClaudeCodingAgentToolset,
  createCodingSubagentTool
} from '@humanlayer/agentlayer-filesystem'

const agentTool = await createCodingSubagentTool({
  cwd: process.cwd(),
  model: 'claude-opus-4-20250514',  // Use a more capable model for subagents
})

const tools = await createClaudeCodingAgentToolset({
  cwd: process.cwd(),
  agentTool
})
```

## Subagent State

Subagent state is automatically managed and serialized:

```ts
// State includes subagent execution state
const result = await run.result
const state = result.state

// Subagent state is preserved for resumption
console.log(state.subagentState)
```

## Event Streaming

Handle events from subagents:

```ts
const agentTool = await createCodingSubagentTool({
  cwd: process.cwd(),
  model: 'claude-sonnet-4-20250514',
  onChildEvent: (event) => {
    if (event.type === 'text') {
      console.log('[Subagent]', event.content)
    }
  }
})
```
