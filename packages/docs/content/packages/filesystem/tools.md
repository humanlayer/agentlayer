# Tools

Individual tool factory functions that create filesystem-based tool implementations.

## Filesystem Tools

### createReadTool()

Read file contents with optional line range.

```ts
import { createReadTool } from '@humanlayer/agentlayer-filesystem'

const readTool = createReadTool({ cwd: '/project' })
```

**Options:**
- `cwd`: Working directory for resolving relative paths

### createWriteTool()

Write content to a file.

```ts
import { createWriteTool } from '@humanlayer/agentlayer-filesystem'

const writeTool = createWriteTool({ cwd: '/project' })
```

### createEditTool()

Replace text in a file using exact string matching.

```ts
import { createEditTool } from '@humanlayer/agentlayer-filesystem'

const editTool = createEditTool({ cwd: '/project' })
```

### createMultiEditTool()

Apply multiple edits to a single file atomically.

```ts
import { createMultiEditTool } from '@humanlayer/agentlayer-filesystem'

const multiEditTool = createMultiEditTool({ cwd: '/project' })
```

### createApplyPatchTool()

Apply unified diff patches.

```ts
import { createApplyPatchTool } from '@humanlayer/agentlayer-filesystem'

const applyPatchTool = createApplyPatchTool({ cwd: '/project' })
```

### createGlobTool()

Find files matching glob patterns.

```ts
import { createGlobTool } from '@humanlayer/agentlayer-filesystem'

const globTool = createGlobTool({ cwd: '/project' })
```

### createGrepTool()

Search file contents with regex.

```ts
import { createGrepTool } from '@humanlayer/agentlayer-filesystem'

const grepTool = createGrepTool({ cwd: '/project' })
```

Uses `ripgrep` when available, with a pure Node.js fallback.

### createListTool()

List directory contents.

```ts
import { createListTool } from '@humanlayer/agentlayer-filesystem'

const listTool = createListTool({ cwd: '/project' })
```

## Shell Tools

### createBashTool()

Execute shell commands.

```ts
import { createBashTool } from '@humanlayer/agentlayer-filesystem'

const bashTool = createBashTool({ cwd: '/project' })
```

## Web Tools

### createWebSearchTool()

Search the web using the Exa API.

```ts
import { createWebSearchTool } from '@humanlayer/agentlayer-filesystem'

const webSearchTool = createWebSearchTool({
  exaApiKey: process.env.EXA_API_KEY,
  endpoint: 'https://api.exa.ai',
  timeoutMs: 30000
})
```

**Options:**
- `exaApiKey`: Exa API key (required)
- `endpoint`: API endpoint (optional)
- `timeoutMs`: Request timeout (optional)

## Option Types

```ts
interface ReadToolOptions {
  cwd?: string
}

interface WriteToolOptions {
  cwd?: string
}

interface EditToolOptions {
  cwd?: string
}

interface MultiEditToolOptions {
  cwd?: string
}

interface ApplyPatchOptions {
  cwd?: string
}

interface WebSearchToolOptions {
  exaApiKey: string
  endpoint?: string
  timeoutMs?: number
}
```

## Using Tools with Agent

```ts
import { Agent } from '@humanlayer/agentlayer-core'
import {
  createReadTool,
  createWriteTool,
  createBashTool
} from '@humanlayer/agentlayer-filesystem'

const cwd = process.cwd()

const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: [
    createReadTool({ cwd }),
    createWriteTool({ cwd }),
    createBashTool({ cwd })
  ],
  system: 'You are a coding assistant.'
})
```

## Utilities

### expandPath()

Expand tilde and resolve relative paths:

```ts
import { expandPath } from '@humanlayer/agentlayer-filesystem'

expandPath('~/projects', '/home/user')  // '/home/user/projects'
expandPath('./src', '/project')         // '/project/src'
```

### runProcess()

Execute external processes with timeout:

```ts
import { runProcess } from '@humanlayer/agentlayer-filesystem'

const result = await runProcess('git', ['status'], {
  cwd: '/project',
  timeout: 30000
})
```

### fsGrepFallback()

Fallback grep implementation using Node.js:

```ts
import { fsGrepFallback } from '@humanlayer/agentlayer-filesystem'

const matches = await fsGrepFallback({
  pattern: 'TODO',
  path: '/project/src',
  glob: '*.ts'
})
```
