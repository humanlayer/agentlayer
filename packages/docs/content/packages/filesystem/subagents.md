# Subagents

The filesystem package provides a pre-configured subagent factory with specialized coding agents.

## createCodingSubagentTool()

Creates a subagent tool with multiple specialized agent types.

```ts
import { createCodingSubagentTool } from '@humanlayer/agentlayer-filesystem'
import { anthropic } from '@ai-sdk/anthropic'

const agentTool = await createCodingSubagentTool({
  cwd: process.cwd(),
  model: anthropic('claude-sonnet-4-20250514'),
  onChildEvent: (event) => console.log('Subagent:', event)
})
```

## Available Agent Types

The tool includes these pre-configured specialist agents:

| Type | Description |
|------|-------------|
| `general-purpose` | General coding tasks, research, multi-step operations |
| `bash` | Focused on shell commands and system operations |
| `codebase-analyzer` | Analyzes implementation details and patterns |
| `codebase-locator` | Finds files and directories relevant to a task |
| `codebase-pattern-finder` | Finds similar implementations and usage examples |
| `implementer-agent` | Follows implementation plans phase by phase |
| `web-search-researcher` | Searches the web for information |
| `library-researcher` | Researches library documentation |

## Usage

The model invokes subagents via the `agent` tool with a description, prompt, and optional agent type. Subagents run to completion and return their result to the parent agent.

## Options

The `CreateCodingSubagentToolOptions` interface extends `CreateAgentFilesystemHooksOptions` and `CreateCodingAgentAuxToolsetOptions`, inheriting their fields.

```ts
import type { LanguageModel } from 'ai'

interface CreateCodingSubagentToolOptions
  extends CreateAgentFilesystemHooksOptions,
    CreateCodingAgentAuxToolsetOptions {
  // The language model instance (from 'ai' package)
  model: LanguageModel
  
  // Optional system prompt customization
  system?: string | string[]
  systemPromptAdditions?: string[]
  
  // Hooks for subagents
  hooks?: AgentConfig['hooks']
  
  // Stop conditions
  stopWhen?: AgentConfig['stopWhen']
  
  // Provider options
  providerOptions?: AgentConfig['providerOptions']
}

// Inherited from CreateAgentFilesystemHooksOptions:
interface CreateAgentFilesystemHooksOptions {
  cwd: string
  outputTruncation?: AgentOutputTruncationOptions
  stripThinking?: StripThinkingOptions
  deduplicateReads?: DeduplicateReadsOptions
  truncateOldBashResults?: TruncateOldBashResultsOptions
}

// Inherited from CreateCodingAgentAuxToolsetOptions:
interface CreateCodingAgentAuxToolsetOptions {
  cwd: string
  agentTool?: Tool<any, any>
  subagents?: SubAgentConfig[]
  skillTool?: Tool<any, any>
  skillDirs?: string | string[] | SkillDirEntry[]
  skills?: Skill[]
  allowMissingSkills?: boolean
  exaApiKey?: string
  context7ApiKey?: string
  webSearchTool?: Tool<any, any>
  webFetchTool?: Tool<any, any>
  additionalTools?: Record<string, Tool<any, any>>
  onChildEvent?: (event: AgentEvent) => void
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
  model: anthropic('claude-opus-4-20250514'),  // Use a more capable model for subagents
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
// Stored under 'subagents' key in state.toolState
console.log(state.toolState?.subagents)
```

## Event Streaming

Handle events from subagents:

```ts
import { anthropic } from '@ai-sdk/anthropic'

const agentTool = await createCodingSubagentTool({
  cwd: process.cwd(),
  model: anthropic('claude-sonnet-4-20250514'),
  onChildEvent: (event) => {
    if (event.type === 'text') {
      console.log('[Subagent]', event.content)
    }
  }
})
```
