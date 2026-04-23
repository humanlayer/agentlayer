# Custom Tools

Learn how to build custom tools for your agents.

## Basic Tool

```ts
import { defineTool } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

const greetTool = defineTool({
  name: 'greet',
  description: 'Greet a person by name',
  input: z.object({
    name: z.string().describe('The name of the person to greet')
  }),
  execute: async (input, ctx) => {
    return `Hello, ${input.name}!`
  }
})
```

## Tool with Validation

Zod schemas provide automatic validation:

```ts
const createUserTool = defineTool({
  name: 'create_user',
  description: 'Create a new user account',
  input: z.object({
    email: z.string().email().describe('Valid email address'),
    age: z.number().min(18).max(120).describe('User age (must be 18+)'),
    role: z.enum(['admin', 'user', 'guest']).describe('User role')
  }),
  execute: async (input, ctx) => {
    // Input is already validated
    const user = await db.users.create(input)
    return `Created user ${user.id}`
  }
})
```

## Tool with State

Tools can maintain state across calls using `stateKey` and `stateSchema`:

```ts
const counterStateSchema = z.object({
  count: z.number()
})

const counterTool = defineTool({
  name: 'counter',
  description: 'Increment and get a counter value',
  input: z.object({
    action: z.enum(['increment', 'get', 'reset'])
  }),
  stateKey: 'counter',
  stateSchema: counterStateSchema,
  execute: async (input, ctx) => {
    const state = ctx.getToolState() ?? { count: 0 }
    
    switch (input.action) {
      case 'increment':
        ctx.updateToolState(() => ({ count: state.count + 1 }))
        return `Counter: ${state.count + 1}`
      case 'get':
        return `Counter: ${state.count}`
      case 'reset':
        ctx.updateToolState(() => ({ count: 0 }))
        return 'Counter reset'
    }
  }
})
```

## Tool with External API

```ts
const weatherTool = defineTool({
  name: 'get_weather',
  description: 'Get current weather for a location',
  input: z.object({
    city: z.string().describe('City name'),
    units: z.enum(['celsius', 'fahrenheit']).default('celsius')
  }),
  execute: async (input, ctx) => {
    const response = await fetch(
      `https://api.weather.com/current?city=${input.city}&units=${input.units}`
    )
    
    if (!response.ok) {
      throw new Error(`Weather API error: ${response.status}`)
    }
    
    const data = await response.json()
    return `${input.city}: ${data.temperature}° ${input.units}, ${data.conditions}`
  }
})
```

## Tool with Database

```ts
const searchProductsTool = defineTool({
  name: 'search_products',
  description: 'Search for products in the database',
  input: z.object({
    query: z.string().describe('Search query'),
    category: z.string().optional().describe('Filter by category'),
    limit: z.number().max(50).default(10).describe('Max results')
  }),
  execute: async (input, ctx) => {
    const products = await db.products.findMany({
      where: {
        name: { contains: input.query },
        ...(input.category && { category: input.category })
      },
      take: input.limit
    })
    
    if (products.length === 0) {
      return 'No products found'
    }
    
    return products
      .map(p => `- ${p.name} ($${p.price})`)
      .join('\n')
  }
})
```

## Tool Interface + Implementation

Separate schema from implementation for reusability:

```ts
import { defineToolInterface } from '@humanlayer/agentlayer-core'

// Define interface (can be shared)
export const NotifyTool = defineToolInterface({
  name: 'notify',
  description: 'Send a notification',
  input: z.object({
    channel: z.enum(['email', 'slack', 'sms']),
    message: z.string()
  })
})

// Implementation for production
const prodNotifyTool = NotifyTool.define(async (input, ctx) => {
  await notificationService.send(input.channel, input.message)
  return `Sent to ${input.channel}`
})

// Implementation for testing
const testNotifyTool = NotifyTool.define(async (input, ctx) => {
  console.log(`[TEST] Would send to ${input.channel}: ${input.message}`)
  return `[TEST] Would send to ${input.channel}`
})

// You can also override the description
const customNotifyTool = NotifyTool.define(
  async (input, ctx) => {
    // custom implementation
    return `Notified via ${input.channel}`
  },
  { description: 'Custom notification sender' }
)
```

## Async/Streaming Tools

Tools can perform long-running operations:

```ts
const runTestsTool = defineTool({
  name: 'run_tests',
  description: 'Run the test suite',
  input: z.object({
    pattern: z.string().optional().describe('Test file pattern')
  }),
  execute: async (input, ctx) => {
    const { execa } = await import('execa')
    
    const args = ['test']
    if (input.pattern) {
      args.push(input.pattern)
    }
    
    try {
      const { stdout } = await execa('bun', args, { timeout: 60000 })
      return stdout
    } catch (error) {
      return `Tests failed:\n${error.stderr || error.message}`
    }
  }
})
```

## Error Handling

Return errors as strings for the model to understand:

```ts
const deployTool = defineTool({
  name: 'deploy',
  description: 'Deploy to environment',
  input: z.object({
    env: z.enum(['staging', 'production'])
  }),
  execute: async (input, ctx) => {
    try {
      await deployment.run(input.env)
      return `Successfully deployed to ${input.env}`
    } catch (error) {
      // Return error message, don't throw
      return `Deployment failed: ${error.message}`
    }
  }
})
```

Or throw to stop execution:

```ts
execute: async (input, ctx) => {
  if (input.env === 'production' && !process.env.PROD_DEPLOY_KEY) {
    throw new Error('Missing PROD_DEPLOY_KEY - cannot deploy to production')
  }
  // ...
}
```

## Tool Context

The execute function receives two arguments: the validated input and a context object:

```ts
execute: async (input, ctx) => {
  // input: Validated input from the model
  
  // ctx.getContextWindow(): Read-only snapshot of conversation messages
  // ctx.updateContextWindow(cb): Queue a deferred mutation to conversation
  // ctx.signal: AbortSignal for cooperative cancellation
  // ctx.stop(options?): Request the agent loop to stop after this tool
  // ctx.getContextWindowTokens(): Estimated token count in context
  // ctx.getContextWindowLimit(): Token limit for current model (or undefined)
  // ctx.toolCallId?: ID of this tool call (for sub-agent grouping)
  // ctx.stream?: Whether to surface live model streaming events
  
  // For stateful tools (with stateKey and stateSchema):
  // ctx.getToolState(): Get current tool state (or undefined)
  // ctx.updateToolState(updater): Update tool state via updater function
}
```

### Using Context Methods

```ts
const exampleTool = defineTool({
  name: 'example',
  description: 'Example tool showing context usage',
  input: z.object({ shouldStop: z.boolean() }),
  execute: async (input, ctx) => {
    // Check context window tokens
    const tokens = ctx.getContextWindowTokens()
    const limit = ctx.getContextWindowLimit()
    
    // Add a follow-up message for the model
    ctx.updateContextWindow((messages) => [
      ...messages,
      { role: 'user', content: 'Additional instruction from tool' }
    ])
    
    // Optionally stop the agent loop
    if (input.shouldStop) {
      return ctx.stop({ reason: 'User requested stop' })
    }
    
    return `Processed with ${tokens} tokens in context`
  }
})
```

## Best Practices

1. **Clear descriptions**: Help the model understand when to use the tool
2. **Validate thoroughly**: Use Zod for input validation
3. **Return useful errors**: Don't just throw, explain what went wrong
4. **Keep it focused**: One tool, one purpose
5. **Consider state**: Use state for tools that need to track information
6. **Test independently**: Tools should be testable outside the agent
