# Tools

Individual tool factory functions that create filesystem-based tool implementations.

## Tool Interface Architecture

AgentLayer separates **tool interfaces** from **tool implementations**. This allows different backends to share serialization logic while implementing only the execution.

### The Read Interface Pattern

The `ReadTool` interface in `@humanlayer/agentlayer-core` defines:
- Input schema (file path, offset, limit)
- Output schema (string)
- A `serialize` method that formats raw file content with right-aligned line numbers and arrow separators

**Before (raw executor output):**
```
import { z } from 'zod'
import { defineToolInterface } from '../define-tool'

export const readInput = z.object({
```

**After (serialized for the model):**
```
1→import { z } from 'zod'
2→import { defineToolInterface } from '../define-tool'
3→
4→export const readInput = z.object({

(Showing lines 1-4 of 39. Use offset=5 to continue.)
```

**With offset=10 (lines numbered from 10):**
```
10→export const ReadTool = defineToolInterface<ReadInput, string>({
11→  name: 'read',
12→  description: 'Read a file with line numbers',

(Showing lines 10-12 of 39. Use offset=13 to continue.)
```

The `serialize` method handles:
- Right-aligned line numbers (width adjusts to largest number)
- Arrow separator (`→`) between line number and content
- Pagination hints when file is truncated
- Correct line numbering when using `offset`

```ts
// In @humanlayer/agentlayer-core/interfaces/read.ts
export const ReadTool = defineToolInterface<ReadInput, string>({
  name: 'read',
  description: 'Read a file with line numbers',
  input: readInput,
  output: z.string(),
  serialize: (raw: string, input: ReadInput) => {
    const lines = raw.split('\n')
    const offset = input.offset ?? 1
    const limit = input.limit ?? 2000
    const slice = lines.slice(offset - 1, offset - 1 + limit)
    const totalLines = lines.length

    // Right-aligned line numbers with arrow separator
    const width = String(offset + slice.length - 1).length
    const numbered = slice
      .map((line, i) => {
        const lineNum = String(offset + i).padStart(width, ' ')
        return `${lineNum}→${line}`
      })
      .join('\n')

    if (slice.length < totalLines) {
      return `${numbered}\n\n(Showing lines ${offset}-${offset + slice.length - 1} of ${totalLines}. Use offset=${offset + slice.length} to continue.)`
    }
    return `${numbered}\n\n(End of file - total ${totalLines} lines)`
  },
})
```

### Backend Implementations

Different backends implement only the **executor** — the serialization is reused automatically.

**Filesystem backend** (`@humanlayer/agentlayer-filesystem`):

```ts
import { ReadTool } from '@humanlayer/agentlayer-core/interfaces'
import { readFile, stat } from 'node:fs/promises'

export function createReadTool(opts: ReadToolOptions = {}) {
  return ReadTool.define(
    async (input) => {
      const filePath = expandPath(input.file_path, opts.cwd)
      // Executor returns raw file content — serialize() handles line numbers
      return await readFile(filePath, 'utf8')
    },
    { description: READ_DESCRIPTION },
  )
}
```

**JustBash backend** (`@humanlayer/agentlayer-justbash`):

```ts
import { ReadTool } from '@humanlayer/agentlayer-core/interfaces'
import type { Bash } from 'just-bash'

export function createJustBashReadTool(bash: Bash) {
  return ReadTool.define(
    async (input) => {
      const result = await bash.exec(`cat "${input.file_path}"`)
      if (result.exitCode !== 0) {
        throw new Error(`File not found: ${input.file_path}`)
      }
      // Executor returns raw content — serialize() adds line numbers
      return result.stdout
    },
    { description: READ_DESCRIPTION },
  )
}
```

### Why This Matters

1. **No duplicate serialization logic** — Line numbering is defined once in the interface
2. **Consistent output format** — All backends produce identical model-facing output
3. **Simple backends** — Implementers only write the file-reading logic
4. **Type safety** — `ReadTool.define()` enforces the correct executor signature

The same pattern applies to other tools (Glob, Grep, List) — each interface defines a `serialize` method that backends get for free.

## Filesystem Tools

### createReadTool()

Read file contents with optional line range.

```ts
import { createReadTool } from '@humanlayer/agentlayer-filesystem'

const readTool = createReadTool({ cwd: '/project' })
```

**Options:**
- `cwd`: Working directory for resolving relative paths

### createReadMultimodalTool()

Read files with support for text, images, and PDFs. Automatically detects file type and returns structured output for multimodal models.

```ts
import { createReadMultimodalTool } from '@humanlayer/agentlayer-filesystem'

const readTool = createReadMultimodalTool({
  cwd: '/project',
  readToolModalities: ['text', 'image', 'pdf']
})
```

**Options:**
- `cwd`: Working directory for resolving relative paths
- `readToolModalities`: Array of enabled modalities. Defaults to `['text']`.
  - `'text'`: Read text files with line-number serialization (default behavior)
  - `'image'`: Return image files as `image-data` content objects (PNG, JPEG, GIF, WEBP)
  - `'pdf'`: Return PDF files as `file-data` content objects

**Output shapes:**
- Text: `{ type: 'text', content: string }`
- Image: `{ type: 'image', content: Uint8Array, mediaType: string }`
- PDF: `{ type: 'pdf', content: Uint8Array, mediaType: 'application/pdf' }`

When the tool's `serialize` method runs, text output is formatted with line numbers as usual. Image and PDF outputs are base64-encoded into structured `content` objects that providers convert to multimodal model inputs.

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

interface ReadMultimodalToolOptions {
  cwd?: string
  readToolModalities?: ReadToolModalities  // e.g. ['text', 'image', 'pdf']
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
  timeoutMs: 30000
})
// result: { stdout: string, stderr: string, exitCode: number, timedOut: boolean }
```

**Parameters:**
- `command`: The command to execute
- `args`: Array of command arguments
- `options`: Optional spawn options plus `timeoutMs` for process timeout

**Returns:** `Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }>`

### fsGrepFallback()

Fallback grep implementation using Node.js (used when `ripgrep` is unavailable):

```ts
import { fsGrepFallback } from '@humanlayer/agentlayer-filesystem'

const matches = await fsGrepFallback(
  'TODO',           // pattern: regex pattern to search
  '/project/src',   // searchPath: directory or file to search
  false,            // disallowSymlinks: skip symlinked directories if true
  '*.ts'            // include: optional file extension filter (e.g. '*.ts')
)
// matches: Array<{ file: string, line: number, content: string }>
```

**Parameters:**
- `pattern`: Regex pattern string to search for
- `searchPath`: Directory or file path to search in
- `disallowSymlinks`: When `true`, symlinked directories are not traversed
- `include`: Optional glob pattern to filter files (e.g. `'*.ts'`)

**Returns:** `Promise<GrepMatch[]>` where `GrepMatch` is `{ file: string; line: number; content: string }`
