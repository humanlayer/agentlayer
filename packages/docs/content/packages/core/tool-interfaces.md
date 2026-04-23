# Tool Interfaces

The core package exports 15+ built-in tool interfaces that define the schema for common agent operations. These are interfaces only - implementations are provided by `agentlayer-filesystem` or `agentlayer-justbash`.

## Filesystem Tools

### ReadTool

Read file contents with optional line range.

```ts
import { ReadTool, readInput, type ReadInput } from '@humanlayer/agentlayer-core/interfaces'

// Input schema
const input: ReadInput = {
  file_path: '/path/to/file.ts',
  offset: 0,      // optional: start line
  limit: 100      // optional: number of lines
}
```

### WriteTool

Write content to a file.

```ts
import { WriteTool, writeInput, type WriteInput } from '@humanlayer/agentlayer-core/interfaces'

const input: WriteInput = {
  file_path: '/path/to/file.ts',
  content: 'file contents here'
}
```

### EditTool

Replace text in a file using exact string matching.

```ts
import { EditTool, editInput, type EditInput } from '@humanlayer/agentlayer-core/interfaces'

const input: EditInput = {
  file_path: '/path/to/file.ts',
  old_string: 'function foo()',
  new_string: 'function bar()',
  replace_all: false  // optional
}

// Output type
type EditOutput = {
  success: boolean
  message: string
}
```

### MultiEditTool

Apply multiple edits to a single file atomically.

```ts
import { MultiEditTool, multiEditInput, type MultiEditInput } from '@humanlayer/agentlayer-core/interfaces'

const input: MultiEditInput = {
  file_path: '/path/to/file.ts',
  edits: [
    { old_string: 'foo', new_string: 'bar' },
    { old_string: 'baz', new_string: 'qux' }
  ]
}
```

### ApplyPatchTool

Apply a unified diff patch to files.

```ts
import { ApplyPatchTool, applyPatchInput, type ApplyPatchInput } from '@humanlayer/agentlayer-core/interfaces'

const input: ApplyPatchInput = {
  patch: `--- a/file.ts
+++ b/file.ts
@@ -1,3 +1,3 @@
-old line
+new line`
}
```

### GlobTool

Find files matching glob patterns.

```ts
import { GlobTool, globInput, type GlobInput } from '@humanlayer/agentlayer-core/interfaces'

const input: GlobInput = {
  pattern: '**/*.ts',
  path: '/project/src'  // optional base path
}
```

### GrepTool

Search file contents with regex.

```ts
import { GrepTool, grepInput, type GrepInput, type GrepMatch } from '@humanlayer/agentlayer-core/interfaces'

const input: GrepInput = {
  pattern: 'function\\s+\\w+',
  path: '/project/src',
  glob: '*.ts',           // optional file filter
  context: 2              // optional context lines
}

// Result type
interface GrepMatch {
  path: string
  line: number
  content: string
  context?: string[]
}
```

### ListTool

List directory contents.

```ts
import { ListTool, listInput, type ListInput, type ListEntry } from '@humanlayer/agentlayer-core/interfaces'

const input: ListInput = {
  path: '/project/src',
  depth: 2  // optional recursion depth
}

interface ListEntry {
  name: string
  type: 'file' | 'directory'
  size?: number
}
```

## Shell Tools

### BashTool

Execute shell commands.

```ts
import { BashTool, bashInput, type BashInput } from '@humanlayer/agentlayer-core/interfaces'

const input: BashInput = {
  command: 'git status',
  timeout: 30000,              // optional: ms
  description: 'Check git status'  // optional
}
```

## Web Tools

### WebFetchTool

Fetch and process web content.

```ts
import { WebFetchTool, webFetchInput, type WebFetchInput } from '@humanlayer/agentlayer-core/interfaces'

const input: WebFetchInput = {
  url: 'https://example.com/docs',
  prompt: 'Extract the API reference'
}
```

### WebSearchTool

Search the web.

```ts
import { WebSearchTool, webSearchInput, type WebSearchInput, type WebSearchResult } from '@humanlayer/agentlayer-core/interfaces'

const input: WebSearchInput = {
  query: 'TypeScript generics tutorial',
  num_results: 10  // optional
}

interface WebSearchResult {
  items: WebSearchResultItem[]
}

interface WebSearchResultItem {
  title: string
  url: string
  snippet: string
}
```

### CodeSearchTool

Search library documentation.

```ts
import { CodeSearchTool, codeSearchInput, type CodeSearchInput } from '@humanlayer/agentlayer-core/interfaces'

const input: CodeSearchInput = {
  query: 'How to use React hooks',
  library: 'react'
}
```

## Skill Tool

### SkillTool

Load and execute skills from markdown files.

```ts
import { SkillTool, skillInput, type SkillInput, type Skill } from '@humanlayer/agentlayer-core/interfaces'

const input: SkillInput = {
  skill: 'refactor',
  args: 'Extract the validation logic'
}

interface Skill {
  name: string
  description?: string
  content: string
}
```

## Comment Tools

Tools for managing file comments (used with yjs-fs):

```ts
import {
  ListCommentsTool, listCommentsInput, type ListCommentsInput,
  CreateCommentTool, createCommentInput, type CreateCommentInput,
  UpdateCommentTool, updateCommentInput, type UpdateCommentInput,
  type CommentOutput
} from '@humanlayer/agentlayer-core/interfaces'
```

## Complete List

| Interface | Input Schema | Description |
|-----------|-------------|-------------|
| `ReadTool` | `readInput` | Read file contents |
| `WriteTool` | `writeInput` | Write file contents |
| `EditTool` | `editInput` | String replacement edit |
| `MultiEditTool` | `multiEditInput` | Multiple edits in one file |
| `ApplyPatchTool` | `applyPatchInput` | Apply unified diff |
| `GlobTool` | `globInput` | Find files by pattern |
| `GrepTool` | `grepInput` | Search file contents |
| `ListTool` | `listInput` | List directory |
| `BashTool` | `bashInput` | Execute shell command |
| `WebFetchTool` | `webFetchInput` | Fetch web content |
| `WebSearchTool` | `webSearchInput` | Web search |
| `CodeSearchTool` | `codeSearchInput` | Library docs search |
| `SkillTool` | `skillInput` | Execute skill |
| `ListCommentsTool` | `listCommentsInput` | List file comments |
| `CreateCommentTool` | `createCommentInput` | Create comment |
| `UpdateCommentTool` | `updateCommentInput` | Update comment |

## Utility Functions

```ts
import { normalizeEscapes } from '@humanlayer/agentlayer-core/interfaces'

// Normalize escape sequences in edit strings
const normalized = normalizeEscapes('line1\\nline2')
```
