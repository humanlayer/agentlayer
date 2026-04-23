# Hook Patterns

Common patterns for using hooks to customize agent behavior.

## Logging All Tool Calls

```ts
import { createPreToolUseHook, createPostToolUseHook, hookNext } from '@humanlayer/agentlayer-core'

const logPreTool = createPreToolUseHook(async (ctx) => {
  console.log(`[${new Date().toISOString()}] Tool: ${ctx.tool.name}`)
  console.log('  Input:', JSON.stringify(ctx.input, null, 2))
  return hookNext()
})

const logPostTool = createPostToolUseHook(async (ctx) => {
  console.log(`  Result: ${ctx.result.slice(0, 200)}...`)
  return hookNext()
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
import { createPreToolUseHook, hookNext, hookDeny, isToolCall } from '@humanlayer/agentlayer-core'
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
      return hookDeny(`Blocked dangerous command matching ${pattern}`)
    }
  }
  
  return hookNext()
})
```

## Rate Limiting

```ts
interface RateLimitState {
  calls: number[]
}

const rateLimitHook = createPreToolUseHook(async (ctx) => {
  const state = ctx.getState('rate-limit') as RateLimitState ?? { calls: [] }
  const now = Date.now()
  const windowMs = 60000  // 1 minute
  const maxCalls = 30
  
  // Remove old calls
  state.calls = state.calls.filter(t => now - t < windowMs)
  
  if (state.calls.length >= maxCalls) {
    return hookDeny(`Rate limit exceeded: ${maxCalls} calls per minute`)
  }
  
  state.calls.push(now)
  ctx.setState('rate-limit', state)
  
  return hookNext()
})
```

## Caching Results

```ts
interface CacheState {
  cache: Map<string, { result: string; timestamp: number }>
}

const cacheHook = createPreToolUseHook(async (ctx) => {
  if (ctx.tool.name !== 'Read') return hookNext()
  
  const state = ctx.getState('cache') as CacheState ?? { cache: new Map() }
  const key = JSON.stringify(ctx.input)
  const cached = state.cache.get(key)
  const maxAge = 30000  // 30 seconds
  
  if (cached && Date.now() - cached.timestamp < maxAge) {
    return hookToolResult(cached.result)
  }
  
  return hookNext()
})

const cacheResultHook = createPostToolUseHook(async (ctx) => {
  if (ctx.tool.name !== 'Read') return hookNext()
  
  const state = ctx.getState('cache') as CacheState ?? { cache: new Map() }
  const key = JSON.stringify(ctx.input)
  
  state.cache.set(key, {
    result: ctx.result,
    timestamp: Date.now()
  })
  ctx.setState('cache', state)
  
  return hookNext()
})
```

## Input Transformation

```ts
const expandPathsHook = createPreToolUseHook(async (ctx) => {
  if (!('path' in ctx.input) && !('file_path' in ctx.input)) {
    return hookNext()
  }
  
  const pathKey = 'path' in ctx.input ? 'path' : 'file_path'
  let path = ctx.input[pathKey]
  
  // Expand ~ to home directory
  if (path.startsWith('~')) {
    path = path.replace('~', process.env.HOME)
  }
  
  // Make relative paths absolute
  if (!path.startsWith('/')) {
    path = `${process.cwd()}/${path}`
  }
  
  return hookNext({
    input: { ...ctx.input, [pathKey]: path }
  })
})
```

## Result Sanitization

```ts
const sanitizeSecretsHook = createPostToolUseHook(async (ctx) => {
  let result = ctx.result
  
  // Remove API keys
  result = result.replace(/sk-[a-zA-Z0-9]{32,}/g, '[REDACTED_API_KEY]')
  
  // Remove passwords
  result = result.replace(/password["\s:=]+["']?[^"'\s]+["']?/gi, 'password=[REDACTED]')
  
  if (result !== ctx.result) {
    return hookToolResult(result)
  }
  
  return hookNext()
})
```

## Approval with Context

```ts
const smartApprovalHook = createApprovalHook(async (ctx) => {
  // Auto-approve reads
  if (ctx.tool.name === 'Read' || ctx.tool.name === 'Glob' || ctx.tool.name === 'Grep') {
    return hookNext()
  }
  
  // Auto-approve safe directories
  if (ctx.tool.name === 'Write' || ctx.tool.name === 'Edit') {
    const path = ctx.input.file_path
    if (path.includes('/tmp/') || path.includes('/test/')) {
      return hookNext()
    }
  }
  
  // Require approval for everything else that modifies files
  if (['Write', 'Edit', 'Bash'].includes(ctx.tool.name)) {
    return hookAsk({
      message: `Allow ${ctx.tool.name}?`,
      toolUseId: ctx.toolUseId
    })
  }
  
  return hookNext()
})
```

## Adding Context Before Requests

```ts
const addContextHook = createPreRequestHook(async (ctx) => {
  return {
    type: 'transform',
    systemAdditions: [
      `Current time: ${new Date().toISOString()}`,
      `Working directory: ${process.cwd()}`,
      `Node version: ${process.version}`
    ]
  }
})
```

## Stopping on Errors

```ts
interface ErrorTrackingState {
  consecutiveErrors: number
}

const stopOnErrorsHook = createPostToolUseHook(async (ctx) => {
  const state = ctx.getState('errors') as ErrorTrackingState ?? { consecutiveErrors: 0 }
  
  const isError = ctx.result.toLowerCase().includes('error') ||
                  ctx.result.toLowerCase().includes('failed')
  
  if (isError) {
    state.consecutiveErrors++
    ctx.setState('errors', state)
    
    if (state.consecutiveErrors >= 3) {
      return hookStop('Too many consecutive errors')
    }
  } else {
    state.consecutiveErrors = 0
    ctx.setState('errors', state)
  }
  
  return hookNext()
})
```

## Composing Hooks

```ts
const agent = new Agent({
  hooks: {
    preToolUse: [
      rateLimitHook,
      blockDangerousCommands,
      expandPathsHook,
      cacheHook
    ],
    postToolUse: [
      cacheResultHook,
      sanitizeSecretsHook,
      stopOnErrorsHook
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
