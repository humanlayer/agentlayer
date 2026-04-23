# Toolsets

High-level factory functions that create complete tool collections optimized for different models.

## Coding Agent Toolsets

### createClaudeCodingAgentToolset()

Creates a comprehensive toolset for Claude models including filesystem tools, skills, subagents, and web tools.

```ts
import { createClaudeCodingAgentToolset } from '@humanlayer/agentlayer-filesystem'

const tools = await createClaudeCodingAgentToolset({
  cwd: process.cwd(),
  skillDirs: ['.claude/skills'],
  exaApiKey: process.env.EXA_API_KEY
})
```

**Includes:**
- Bash, Read, Write, Edit, Glob, Grep, List
- Skill tool (from repo directories)
- WebFetch, WebSearch (if API key provided)
- Subagent tools (if configured)

**Options:**

```ts
interface CreateCodingAgentToolsetOptions {
  cwd: string
  
  // Skill configuration
  skillDirs?: string | string[] | SkillDirEntry[]
  skills?: Skill[]
  skillTool?: Tool
  allowMissingSkills?: boolean
  
  // Web tools
  exaApiKey?: string
  context7ApiKey?: string
  webSearchTool?: Tool
  webFetchTool?: Tool
  
  // Subagents
  subagents?: SubAgentConfig[]
  agentTool?: Tool
  onChildEvent?: (event: AgentEvent) => void
  
  // Extras
  additionalTools?: Record<string, Tool<any, any>>
}
```

### createCodexCodingAgentToolset()

Creates a toolset optimized for Codex/OpenAI models (uses `apply_patch` instead of `edit`).

```ts
import { createCodexCodingAgentToolset } from '@humanlayer/agentlayer-filesystem'

const tools = await createCodexCodingAgentToolset({
  cwd: process.cwd()
})
```

**Includes:**
- Bash, Read, ApplyPatch, Glob, Grep, List
- (Same auxiliary tools as Claude toolset)

## Filesystem-Only Toolsets

### createClaudeAgentFilesystemToolset()

Just the core filesystem tools for Claude (no skills, web, or subagents). Returns a `Record<string, Tool>` object.

```ts
import { createClaudeAgentFilesystemToolset } from '@humanlayer/agentlayer-filesystem'

const tools = createClaudeAgentFilesystemToolset({ cwd: process.cwd() })
// { bash, read, write, edit, glob, grep, list }
```

### createCodexAgentFilesystemToolset()

Just the core filesystem tools for Codex. Returns a `Record<string, Tool>` object.

```ts
import { createCodexAgentFilesystemToolset } from '@humanlayer/agentlayer-filesystem'

const tools = createCodexAgentFilesystemToolset({ cwd: process.cwd() })
// { bash, read, apply_patch, glob, grep, list }
```

## Auxiliary Toolset

### createCodingAgentAuxToolset()

Creates auxiliary tools (skills, web, subagents) without filesystem tools.

```ts
import { createCodingAgentAuxToolset } from '@humanlayer/agentlayer-filesystem'

const auxTools = await createCodingAgentAuxToolset({
  cwd: process.cwd(),
  skillDirs: ['.claude/skills'],
  exaApiKey: process.env.EXA_API_KEY
})
```

Useful for combining with custom filesystem tools.

## Choosing a Toolset

| Toolset | Use Case |
|---------|----------|
| `createClaudeCodingAgentToolset` | Full-featured Claude agent with all capabilities |
| `createCodexCodingAgentToolset` | Full-featured OpenAI/Codex agent |
| `createClaudeAgentFilesystemToolset` | Minimal Claude agent, just filesystem ops |
| `createCodexAgentFilesystemToolset` | Minimal Codex agent, just filesystem ops |
| `createCodingAgentAuxToolset` | Just skills/web/subagents, bring your own filesystem |

## Complete Example

```ts
import { Agent, maxSteps } from '@humanlayer/agentlayer-core'
import {
  createClaudeCodingAgentToolset,
  createAgentSystemPrompt,
  createAgentFilesystemHooks
} from '@humanlayer/agentlayer-filesystem'

const cwd = process.cwd()

const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: await createClaudeCodingAgentToolset({
    cwd,
    exaApiKey: process.env.EXA_API_KEY,
    skillDirs: ['.claude/skills', '.agents/skills']
  }),
  system: await createAgentSystemPrompt({ cwd, model: 'claude' }),
  hooks: createAgentFilesystemHooks({ cwd }),
  stopWhen: [maxSteps(100)]
})
```
