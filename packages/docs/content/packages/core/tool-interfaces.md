# Tool Interfaces

The core package exports built-in tool interfaces that define the schema for common agent operations. These are interfaces only - implementations are provided by [`agentlayer-filesystem`](/packages/filesystem/tools) or [`agentlayer-justbash`](/packages/justbash/tools).

## Filesystem Tools

### ReadTool

Read file contents with line numbers.

```ts
import { ReadTool, readInput, type ReadInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_path` | `string` | Yes | - | Absolute path to the file to read |
| `offset` | `number` | No | `1` | Line number to start from (1-indexed) |
| `limit` | `number` | No | `2000` | Maximum number of lines to read |

**Implementations:** [`createReadTool()`](/packages/filesystem/tools#createreadtool), [`createJustBashReadTool()`](/packages/justbash/tools#createjustbashreadtool)

### WriteTool

Write content to a file. Creates parent directories if needed.

```ts
import { WriteTool, writeInput, type WriteInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | `string` | Yes | Path to the file to write |
| `content` | `string` | Yes | Content to write to the file |

**Implementations:** [`createWriteTool()`](/packages/filesystem/tools#createwritetool)

### EditTool

Replace text in a file using exact string matching.

```ts
import { EditTool, editInput, type EditInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `file_path` | `string` | Yes | - | Path to the file to edit |
| `old_string` | `string` | Yes | - | Exact string to find and replace |
| `new_string` | `string` | Yes | - | Replacement string |
| `replace_all` | `boolean` | No | `false` | Replace all occurrences (if false, fails when multiple matches found) |

**Implementations:** [`createEditTool()`](/packages/filesystem/tools#createedittool)

### MultiEditTool

Apply multiple edits to a single file atomically.

```ts
import { MultiEditTool, multiEditInput, type MultiEditInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | `string` | Yes | Path to the file to edit |
| `edits` | `Array<{old_string, new_string}>` | Yes | Array of edits to apply |

**Implementations:** [`createMultiEditTool()`](/packages/filesystem/tools#createmultiedittool)

### ApplyPatchTool

Apply patches to create, modify, move, or delete files. Uses a custom patch format (not unified diff).

```ts
import { ApplyPatchTool, applyPatchInput, type ApplyPatchInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `patch_text` | `string` | Yes | Patch content wrapped in `*** Begin Patch` / `*** End Patch` |

**Implementations:** [`createApplyPatchTool()`](/packages/filesystem/tools#createapplypatchtool)

### GlobTool

Find files matching glob patterns.

```ts
import { GlobTool, globInput, type GlobInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pattern` | `string` | Yes | - | Glob pattern (e.g., `**/*.ts`, `src/**/*.js`) |
| `path` | `string` | No | cwd | Base directory to search in |

**Implementations:** [`createGlobTool()`](/packages/filesystem/tools#createglobtool)

### GrepTool

Search file contents with regex.

```ts
import { GrepTool, grepInput, type GrepInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `pattern` | `string` | Yes | - | Regex pattern to search for |
| `path` | `string` | No | cwd | File or directory to search in |
| `include` | `string` | No | - | Glob filter for files (e.g., `*.ts`) |

**Implementations:** [`createGrepTool()`](/packages/filesystem/tools#creategreptool)

### ListTool

List directory contents (single level).

```ts
import { ListTool, listInput, type ListInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `path` | `string` | No | cwd | Directory to list |
| `ignore` | `string[]` | No | - | Patterns to ignore |

**Implementations:** [`createListTool()`](/packages/filesystem/tools#createlisttool)

## Shell Tools

### BashTool

Execute shell commands.

```ts
import { BashTool, bashInput, type BashInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `command` | `string` | Yes | - | Shell command to execute |
| `timeout` | `number` | No | `120000` | Timeout in milliseconds |
| `workdir` | `string` | No | cwd | Working directory for the command |
| `description` | `string` | No | - | Short description of what the command does |

**Implementations:** [`createBashTool()`](/packages/filesystem/tools#createbashtool), [`createJustBashTool()`](/packages/justbash/tools#createjustbashtool)

## Web Tools

### WebFetchTool

Fetch and process web content.

```ts
import { WebFetchTool, webFetchInput, type WebFetchInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `url` | `string` | Yes | - | URL to fetch |
| `format` | `'text' \| 'markdown' \| 'html'` | No | `'markdown'` | Output format |
| `timeout` | `number` | No | `30000` | Request timeout in ms (max: 120000) |

**Implementations:** [`createWebFetchTool()`](/packages/filesystem/tools#createwebfetchtool)

### WebSearchTool

Search the web.

```ts
import { WebSearchTool, webSearchInput, type WebSearchInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | - | Search query |
| `numResults` | `number` | No | `5` | Maximum results to return |

**Implementations:** [`createWebSearchTool()`](/packages/filesystem/tools#createwebsearchtool)

### CodeSearchTool

Search library documentation.

```ts
import { CodeSearchTool, codeSearchInput, type CodeSearchInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | `string` | Yes | - | Question about the library |
| `packageName` | `string` | Yes | - | Package name (e.g., `react`, `express`) |
| `language` | `string` | No | `'typescript'` | Programming language context |

**Implementations:** [`createCodeSearchTool()`](/packages/justbash/tools#createcodesearchtool)

## Skill Tool

### SkillTool

Load and execute skills from markdown files. See [Skills](/packages/filesystem/skills) for more details.

```ts
import { SkillTool, skillInput, type SkillInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | `string` | Yes | Name of the skill to execute |
| `args` | `string` | No | Arguments to pass to the skill |

**Implementations:** [`createSkillTool()`](/packages/filesystem/skills#createskilltool)

## File Management Tools

### CreateFileTool

Create a new file with content.

```ts
import { CreateFileTool, createFileInput, type CreateFileInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | `string` | Yes | Path for the new file |
| `content` | `string` | Yes | Content to write |

### DeleteFileTool

Delete a file.

```ts
import { DeleteFileTool, deleteFileInput, type DeleteFileInput } from '@humanlayer/agentlayer-core/interfaces'
```

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | `string` | Yes | Path to the file to delete |

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
| `CreateFileTool` | `createFileInput` | Create a new file |
| `DeleteFileTool` | `deleteFileInput` | Delete a file |
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
