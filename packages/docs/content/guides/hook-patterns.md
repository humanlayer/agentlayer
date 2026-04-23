# Hook Patterns

Common patterns for using hooks to customize agent behavior.

## Logging All Tool Calls

```ts
import { createPreToolUseHook, createPostToolUseHook } from '@humanlayer/agentlayer-core'
import { ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool } from '@humanlayer/agentlayer-core/interfaces'

const allTools = [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool] as const

const logPreTool = createPreToolUseHook(allTools, async (ctx) => {
  console.log(`[${new Date().toISOString()}] Tool: ${ctx.tool.name}`)
  console.log('  Input:', JSON.stringify(ctx.input, null, 2))
  return ctx.next()
})

const logPostTool = createPostToolUseHook(allTools, async (ctx) => {
  console.log(`  Result: ${ctx.output.slice(0, 200)}...`)
  return ctx.done()
})

const agent = new Agent({
  hooks: {
    preToolUse: [logPreTool],
    postToolUse: [logPostTool]
  }
})
```

## Blocking Dangerous Commands

```ts
import { createPreToolUseHook } from '@humanlayer/agentlayer-core'
import { BashTool } from '@humanlayer/agentlayer-core/interfaces'

const DANGEROUS_PATTERNS = [
  /rm\s+-rf/,
  />\s*\/dev\/sd/,
  /mkfs/,
  /dd\s+if=/,
  /:(){ :|:& };:/  // fork bomb
]

const blockDangerousCommands = createPreToolUseHook(BashTool, async (ctx) => {
  const command = ctx.input.command
  
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return ctx.toolResult(`Blocked dangerous command matching ${pattern}`, { isError: true })
    }
  }
  
  return ctx.next()
})
```

## Rate Limiting

```ts
import { createPreToolUseHook } from '@humanlayer/agentlayer-core'
import { ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool } from '@humanlayer/agentlayer-core/interfaces'

interface RateLimitState {
  calls: number[]
}

const allTools = [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool] as const

const rateLimitHook = createPreToolUseHook(allTools, async (ctx) => {
  const state = ctx.getState<RateLimitState>('rate-limit') ?? { calls: [] }
  const now = Date.now()
  const windowMs = 60000  // 1 minute
  const maxCalls = 30
  
  // Remove old calls
  const recentCalls = state.calls.filter(t => now - t < windowMs)
  
  if (recentCalls.length >= maxCalls) {
    return ctx.toolResult(`Rate limit exceeded: ${maxCalls} calls per minute`, { isError: true })
  }
  
  ctx.updateState<RateLimitState>('rate-limit', (current) => ({
    calls: [...(current?.calls ?? []).filter(t => now - t < windowMs), now]
  }))
  
  return ctx.next()
})
```

## Caching Results

```ts
import { createPreToolUseHook, createPostToolUseHook } from '@humanlayer/agentlayer-core'
import { ReadTool } from '@humanlayer/agentlayer-core/interfaces'

interface CacheEntry {
  result: string
  timestamp: number
}

interface CacheState {
  cache: Record<string, CacheEntry>
}

const cacheHook = createPreToolUseHook(ReadTool, async (ctx) => {
  const state = ctx.getState<CacheState>('cache') ?? { cache: {} }
  const key = JSON.stringify(ctx.input)
  const cached = state.cache[key]
  const maxAge = 30000  // 30 seconds
  
  if (cached && Date.now() - cached.timestamp < maxAge) {
    return ctx.toolResult(cached.result)
  }
  
  return ctx.next()
})

const cacheResultHook = createPostToolUseHook(ReadTool, async (ctx) => {
  const key = JSON.stringify(ctx.input)
  
  ctx.updateState<CacheState>('cache', (current) => ({
    cache: {
      ...(current?.cache ?? {}),
      [key]: {
        result: ctx.output,
        timestamp: Date.now()
      }
    }
  }))
  
  return ctx.done()
})
```

## Input Transformation

```ts
import { createPreToolUseHook } from '@humanlayer/agentlayer-core'
import { ReadTool, WriteTool, EditTool } from '@humanlayer/agentlayer-core/interfaces'

const fileTools = [ReadTool, WriteTool, EditTool] as const

const expandPathsHook = createPreToolUseHook(fileTools, async (ctx) => {
  if (!('path' in ctx.input) && !('file_path' in ctx.input)) {
    return ctx.next()
  }
  
  const pathKey = 'path' in ctx.input ? 'path' : 'file_path'
  let path = ctx.input[pathKey] as string
  
  // Expand ~ to home directory
  if (path.startsWith('~')) {
    path = path.replace('~', process.env.HOME ?? '')
  }
  
  // Make relative paths absolute
  if (!path.startsWith('/')) {
    path = `${process.cwd()}/${path}`
  }
  
  return ctx.next({ ...ctx.input, [pathKey]: path })
})
```

## Result Sanitization

```ts
import { createPostToolUseHook } from '@humanlayer/agentlayer-core'
import { ReadTool, BashTool, GrepTool } from '@humanlayer/agentlayer-core/interfaces'

const toolsWithOutput = [ReadTool, BashTool, GrepTool] as const

const sanitizeSecretsHook = createPostToolUseHook(toolsWithOutput, async (ctx) => {
  let result = ctx.output
  
  // Remove API keys
  result = result.replace(/sk-[a-zA-Z0-9]{32,}/g, '[REDACTED_API_KEY]')
  
  // Remove passwords
  result = result.replace(/password["\s:=]+["']?[^"'\s]+["']?/gi, 'password=[REDACTED]')
  
  if (result !== ctx.output) {
    return ctx.done(result)
  }
  
  return ctx.done()
})
```

## Approval with Context

```ts
import { createApprovalHook, hookAsk } from '@humanlayer/agentlayer-core'
import { WriteTool, EditTool, BashTool } from '@humanlayer/agentlayer-core/interfaces'

const modifyingTools = [WriteTool, EditTool, BashTool] as const

const smartApprovalHook = createApprovalHook(modifyingTools, async (ctx) => {
  // Auto-approve safe directories for Write/Edit
  if (ctx.toolName === 'Write' || ctx.toolName === 'Edit') {
    const path = ctx.input.file_path as string
    if (path.includes('/tmp/') || path.includes('/test/')) {
      return ctx.next()
    }
  }
  
  // Require approval for everything else that modifies files
  return hookAsk({
    id: ctx.toolCallId,
    toolName: ctx.toolName,
    toolCallId: ctx.toolCallId,
    input: ctx.input,
    message: `Allow ${ctx.toolName}?`
  })
})
```

## Adding Context Before Requests

```ts
import { createPreRequestHook } from '@humanlayer/agentlayer-core'
import type { ModelMessage } from 'ai'

const addContextHook = createPreRequestHook(async (ctx) => {
  const contextInfo = [
    `Current time: ${new Date().toISOString()}`,
    `Working directory: ${process.cwd()}`,
    `Node version: ${process.version}`
  ].join('\n')
  
  // Prepend a system message with context
  const systemMessage: ModelMessage = {
    role: 'system',
    content: contextInfo
  }
  
  return ctx.transform([systemMessage, ...ctx.messages])
})
```

## Stopping on Errors

Note: Post-tool-use hooks can only return `DoneResult` via `ctx.done()`. To stop the agent on errors, 
use a pre-tool-use hook that checks state, or handle error detection in the agent loop.

```ts
import { createPostToolUseHook, createPreToolUseHook } from '@humanlayer/agentlayer-core'
import { ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool } from '@humanlayer/agentlayer-core/interfaces'

interface ErrorTrackingState {
  consecutiveErrors: number
}

const allTools = [ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool] as const

// Track errors in post-tool-use hook
const trackErrorsHook = createPostToolUseHook(allTools, async (ctx) => {
  const isError = ctx.output.toLowerCase().includes('error') ||
                  ctx.output.toLowerCase().includes('failed')
  
  ctx.updateState<ErrorTrackingState>('errors', (current) => ({
    consecutiveErrors: isError ? (current?.consecutiveErrors ?? 0) + 1 : 0
  }))
  
  return ctx.done()
})

// Check error count in pre-tool-use hook and stop if too many
const stopOnTooManyErrorsHook = createPreToolUseHook(allTools, async (ctx) => {
  const state = ctx.getState<ErrorTrackingState>('errors')
  
  if (state && state.consecutiveErrors >= 3) {
    return ctx.stop({ reason: 'Too many consecutive errors' })
  }
  
  return ctx.next()
})
```

## Composing Hooks

```ts
const agent = new Agent({
  hooks: {
    preToolUse: [
      stopOnTooManyErrorsHook,  // Check error state first
      rateLimitHook,
      blockDangerousCommands,
      expandPathsHook,
      cacheHook
    ],
    postToolUse: [
      cacheResultHook,
      sanitizeSecretsHook,
      trackErrorsHook
    ],
    approval: [
      smartApprovalHook
    ],
    preRequest: [
      addContextHook
    ]
  }
})
```

Hooks run in order. Use early hooks for validation/blocking, later hooks for transformation.
