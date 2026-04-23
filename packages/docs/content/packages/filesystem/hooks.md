# Hooks

The filesystem package provides hooks for file state tracking, wasted read detection, and output truncation.

## Complete Hook Factory

### createAgentFilesystemHooks()

Creates a complete hooks configuration for filesystem agents.

```ts
import { createAgentFilesystemHooks } from '@humanlayer/agentlayer-filesystem'

const { preToolUse, postToolUse, preRequest } = createAgentFilesystemHooks({
  cwd: process.cwd(),
  outputTruncation: {
    maxLines: 2000,
    maxBytes: 50 * 1024
  }
})

const agent = new Agent({
  model: '...',
  tools: [...],
  hooks: {
    preToolUse,
    postToolUse,
    preRequest
  }
})
```

**Options:**

```ts
interface CreateAgentFilesystemHooksOptions {
  cwd: string  // Required
  
  // Output truncation options
  outputTruncation?: AgentOutputTruncationOptions
  
  // Pre-request hook options
  stripThinking?: StripThinkingOptions
  deduplicateReads?: DeduplicateReadsOptions
  truncateOldBashResults?: TruncateOldBashResultsOptions
}

interface AgentOutputTruncationOptions {
  maxLines?: number     // Default: 2000
  maxBytes?: number     // Default: 50 * 1024 (51200)
  maxLineWidth?: number // Default: undefined (no cap)
}
```

## File State Tracking

### createFileStateTrackingHook()

Tracks which files have been read and their line ranges.

```ts
import { createFileStateTrackingHook } from '@humanlayer/agentlayer-filesystem'

const trackingHook = createFileStateTrackingHook({ cwd: process.cwd() })
```

The hook maintains state about file reads:

```ts
interface FileStateEntry {
  lastReadHash?: string
  lastVerifiedHash?: string
  wastedRead?: WastedReadTracking
}

interface WastedReadTracking {
  hash: string
  totalLines: number
  ranges: LineRange[]
}

interface LineRange {
  startLine: number
  endLine: number
}
```

## Wasted Read Detection

Detects when agents read files unnecessarily.

### createWastedReadHook()

Warns when reading a file that's about to be overwritten.

```ts
import { createWastedReadHook } from '@humanlayer/agentlayer-filesystem'

const wastedReadHook = createWastedReadHook({ cwd: process.cwd() })
```

### createWastedReadHooks()

Returns both pre and post hooks for complete tracking.

```ts
import { createWastedReadHooks } from '@humanlayer/agentlayer-filesystem'

const { preToolUseHook, postToolUseHook } = createWastedReadHooks({ cwd: process.cwd() })
```

### createReadBeforeWriteHook()

Warns when writing to a file without reading it first.

```ts
import { createReadBeforeWriteHook } from '@humanlayer/agentlayer-filesystem'

const readBeforeWriteHook = createReadBeforeWriteHook({ cwd: process.cwd() })
```

### createReadBeforeWriteHooks()

Returns both pre and post hooks.

```ts
import { createReadBeforeWriteHooks } from '@humanlayer/agentlayer-filesystem'

const { preToolUseHook, postToolUseHook } = createReadBeforeWriteHooks({ cwd: process.cwd() })
```

## Output Truncation

Hooks that truncate excessive tool output to save context.

### Individual Truncation Hooks

```ts
import {
  createReadTruncationHook,
  createBashOutputTruncationHook,
  createGlobOutputTruncationHook,
  createGrepOutputTruncationHook,
  createListOutputTruncationHook
} from '@humanlayer/agentlayer-filesystem'

const options = {
  maxLines: 2000,        // Default: 2000
  maxBytes: 50 * 1024,   // Default: 50 * 1024 (51200)
  maxLineWidth: 2000     // Default: undefined (no cap), except ReadTruncationHook (default: 2000)
}

const readHook = createReadTruncationHook(options)
const bashHook = createBashOutputTruncationHook(options)
const globHook = createGlobOutputTruncationHook(options)
const grepHook = createGrepOutputTruncationHook(options)
const listHook = createListOutputTruncationHook(options)
```

### Pre-configured Hook Instances

```ts
import {
  readTruncationHook,
  bashOutputTruncationHook,
  globOutputTruncationHook,
  grepOutputTruncationHook,
  listOutputTruncationHook,
  saneDefaultOutputTruncationHooks
} from '@humanlayer/agentlayer-filesystem'

// Use pre-configured defaults
const hooks = {
  postToolUse: saneDefaultOutputTruncationHooks
}
```

## Truncation Options

```ts
interface TruncationOptions {
  maxLines?: number       // Max lines to keep (default: 2000)
  maxBytes?: number       // Max bytes to keep (default: 50 * 1024 = 51200)
  maxLineWidth?: number   // Max characters per line (default: undefined, no cap)
  direction?: 'head' | 'tail'  // Which end to keep (default: 'head')
}
```

## Combining Hooks

```ts
import { Agent } from '@humanlayer/agentlayer-core'
import {
  createFileStateTrackingHook,
  createWastedReadHooks,
  saneDefaultOutputTruncationHooks
} from '@humanlayer/agentlayer-filesystem'

const cwd = process.cwd()
const wastedRead = createWastedReadHooks({ cwd })

const agent = new Agent({
  model: '...',
  tools: [...],
  hooks: {
    preToolUse: [
      wastedRead.preToolUseHook
    ],
    postToolUse: [
      createFileStateTrackingHook({ cwd }),
      wastedRead.postToolUseHook,
      ...saneDefaultOutputTruncationHooks
    ]
  }
})
```

## Constants

```ts
import { FILE_STATE_KEY } from '@humanlayer/agentlayer-filesystem'

// Key used for file state in hook state storage
// FILE_STATE_KEY = 'fileState'
```

## Type Exports

```ts
import type {
  FileStateEntry,
  FileStateMap,
  FileStateHookOptions,
  FileStateHookPair,
  LineRange,
  WastedReadTracking,
  TruncationOptions,
  TruncationResult,
  OutputTruncationOptions,
  ReadTruncationOptions,
  AgentOutputTruncationOptions,
} from '@humanlayer/agentlayer-filesystem'
```
