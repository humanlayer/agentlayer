# Prompts

System prompt generation for just-bash environments.

## createAgentSystemPrompt()

Build a complete system prompt with environment context. Returns a `Promise<string[]>` - an array of prompt sections that can be passed to an agent's `system` option.

```ts
import { Bash } from 'just-bash'
import { createAgentSystemPrompt } from '@humanlayer/agentlayer-justbash'

const bash = new Bash()

// Returns Promise<string[]> - an array of prompt sections
const systemPromptParts = await createAgentSystemPrompt({
  bash,
  cwd: '/workspace',
  model: 'claude',
  includeEnvironment: true,
  systemPromptAdditions: ['Additional context...']
})

// Use with an agent
const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: [...],
  system: systemPromptParts  // string[] - array of prompt sections
})
```

**Options:**

```ts
interface CreateAgentSystemPromptOptions {
  bash: Bash                          // just-bash instance
  cwd: string                         // Working directory
  model: CodingPromptKey | string     // Model or prompt key
  
  // Optional
  filePath?: string                   // Specific instructions file
  candidates?: string[]               // Instruction file candidates
  allowMissingRepoInstructions?: boolean
  includeEnvironment?: boolean
  platform?: string
  date?: Date
  systemPromptAdditions?: string[]
}
```

## environmentPrompt()

Generate environment context.

```ts
import { environmentPrompt } from '@humanlayer/agentlayer-justbash'

const env = await environmentPrompt(bash, {
  cwd: '/workspace',
  platform: 'linux',
  date: new Date()
})
```

Automatically detects if the cwd is a git repository.

**Options:**

```ts
// Extends CoreEnvironmentPromptOptions from @humanlayer/agentlayer-core/prompts,
// but makes isGitRepo optional (auto-detected if not provided)
interface EnvironmentPromptOptions extends Omit<CoreEnvironmentPromptOptions, 'isGitRepo'> {
  cwd: string
  platform?: string
  date?: Date
  isGitRepo?: boolean  // Auto-detected if not provided
}
```

## repoInstructionsPrompt()

Load repository instructions from CLAUDE.md, AGENTS.md, or similar files.

```ts
import { repoInstructionsPrompt } from '@humanlayer/agentlayer-justbash'

const instructions = await repoInstructionsPrompt(bash, {
  cwd: '/workspace',
  candidates: ['CLAUDE.md', 'AGENTS.md', 'CONTEXT.md'],
  allowMissing: true
})
```

**Options:**

```ts
interface RepoInstructionsPromptOptions {
  cwd: string
  filePath?: string           // Specific file path
  candidates?: string[]       // Files to search for
  allowMissing?: boolean      // Don't error if not found
}
```

## Re-exports from agentlayer-core

The following are re-exported from `@humanlayer/agentlayer-core/prompts`:

```ts
import {
  CodingModelFamily,          // Type for model family classification
  CodingPromptKey,
  buildCodingProviderOptions,
  detectModelFamily,
  getSystemPromptForModel,
  resolveCodingModelPrompt,
  systemPrompts,
  tarsPersona
} from '@humanlayer/agentlayer-justbash/prompts'
```

## Complete Example

```ts
import { Bash } from 'just-bash'
import { Agent } from '@humanlayer/agentlayer-core'
import {
  createJustBashTool,
  createJustBashReadTool,
  createWriteTool,
  createAgentSystemPrompt
} from '@humanlayer/agentlayer-justbash'

const bash = new Bash()
const cwd = '/workspace'

// createAgentSystemPrompt returns Promise<string[]>
const systemPromptParts = await createAgentSystemPrompt({
  bash,
  cwd,
  model: 'claude',
  systemPromptAdditions: [
    'This is a sandboxed environment.',
    'You have access to a virtual filesystem.'
  ]
})

const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: [
    createJustBashTool(bash),
    createJustBashReadTool(bash),
    createWriteTool(bash)
  ],
  system: systemPromptParts  // string[] - array of prompt sections
})
```
