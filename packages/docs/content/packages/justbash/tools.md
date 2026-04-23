# Tools

Tool factory functions that create just-bash-based tool implementations.

## Filesystem Tools

All tool factories take a `Bash` instance from just-bash as their first argument.

### createJustBashTool()

Execute shell commands.

```ts
import { Bash } from 'just-bash'
import { createJustBashTool } from '@humanlayer/agentlayer-justbash'

const bash = new Bash()
const bashTool = createJustBashTool(bash)
```

### createJustBashReadTool()

Read file contents.

```ts
import { createJustBashReadTool } from '@humanlayer/agentlayer-justbash'

const readTool = createJustBashReadTool(bash)
```

### createWriteTool()

Write content to a file.

```ts
import { createWriteTool } from '@humanlayer/agentlayer-justbash'

const writeTool = createWriteTool(bash)
```

### createEditTool()

Replace text in a file.

```ts
import { createEditTool } from '@humanlayer/agentlayer-justbash'

const editTool = createEditTool(bash)
```

### createGlobTool()

Find files matching glob patterns.

```ts
import { createGlobTool } from '@humanlayer/agentlayer-justbash'

const globTool = createGlobTool(bash)
```

### createGrepTool()

Search file contents with regex.

```ts
import { createGrepTool } from '@humanlayer/agentlayer-justbash'

const grepTool = createGrepTool(bash)
```

### createListTool()

List directory contents.

```ts
import { createListTool } from '@humanlayer/agentlayer-justbash'

const listTool = createListTool(bash)
```

### createApplyPatchTool()

Apply unified diff patches.

```ts
import { createApplyPatchTool } from '@humanlayer/agentlayer-justbash'

const applyPatchTool = createApplyPatchTool(bash, { cwd: '/workspace' })
```

**Options:**

```ts
interface ApplyPatchOptions {
  cwd?: string
}
```

## Web Tools

### createWebFetchTool()

Fetch and process web content.

```ts
import { createWebFetchTool } from '@humanlayer/agentlayer-justbash'

const webFetchTool = createWebFetchTool(bash)
```

### createWebSearchTool()

Search the web using the Exa API.

```ts
import { createWebSearchTool } from '@humanlayer/agentlayer-justbash'

const webSearchTool = createWebSearchTool(bash, {
  exaApiKey: process.env.EXA_API_KEY,
  timeoutSec: 30
})
```

**Options:**

```ts
interface JustBashWebSearchOptions {
  exaApiKey: string
  timeoutSec?: number
}
```

### createCodeSearchTool()

Search library documentation.

```ts
import { createCodeSearchTool } from '@humanlayer/agentlayer-justbash'

const codeSearchTool = createCodeSearchTool(bash, {
  exaApiKey: process.env.EXA_API_KEY,
  context7ApiKey: process.env.CONTEXT7_API_KEY,
  timeoutSec: 30
})
```

**Options:**

```ts
interface JustBashCodeSearchOptions {
  exaApiKey?: string
  context7ApiKey?: string
  timeoutSec?: number
}
```

## Skill Tool

### createSkillToolFromVFS()

Create a skill tool from virtual filesystem directories.

```ts
import { createSkillToolFromVFS } from '@humanlayer/agentlayer-justbash'

const skillTool = await createSkillToolFromVFS(bash, {
  dirs: ['.claude/skills'],
  skills: []  // Additional skills
})
```

## Complete Example

```ts
import { Bash } from 'just-bash'
import { Agent } from '@humanlayer/agentlayer-core'
import {
  createJustBashTool,
  createJustBashReadTool,
  createWriteTool,
  createEditTool,
  createGlobTool,
  createGrepTool,
  createListTool
} from '@humanlayer/agentlayer-justbash'

const bash = new Bash()

const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: [
    createJustBashTool(bash),
    createJustBashReadTool(bash),
    createWriteTool(bash),
    createEditTool(bash),
    createGlobTool(bash),
    createGrepTool(bash),
    createListTool(bash)
  ],
  system: 'You are a coding assistant working in a sandboxed environment.'
})
```

## Tool Summary

| Factory | Tool Name | Description |
|---------|-----------|-------------|
| `createJustBashTool` | Bash | Execute shell commands |
| `createJustBashReadTool` | Read | Read file contents |
| `createWriteTool` | Write | Write file contents |
| `createEditTool` | Edit | String replacement edit |
| `createGlobTool` | Glob | Find files by pattern |
| `createGrepTool` | Grep | Search file contents |
| `createListTool` | List | List directory |
| `createApplyPatchTool` | ApplyPatch | Apply unified diff |
| `createWebFetchTool` | WebFetch | Fetch web content |
| `createWebSearchTool` | WebSearch | Web search |
| `createCodeSearchTool` | CodeSearch | Library docs search |
| `createSkillToolFromVFS` | Skill | Execute skills |
