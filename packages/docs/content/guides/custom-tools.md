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
  execute: async ({ input }) => {
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
  execute: async ({ input }) => {
    // Input is already validated
    const user = await db.users.create(input)
    return `Created user ${user.id}`
  }
})
```

## Tool with State

Tools can maintain state across calls:

```ts
interface CounterState {
  count: number
}

const counterTool = defineTool({
  name: 'counter',
  description: 'Increment and get a counter value',
  input: z.object({
    action: z.enum(['increment', 'get', 'reset'])
  }),
  state: {
    key: 'counter',
    initial: (): CounterState => ({ count: 0 })
  },
  execute: async ({ input, getState, setState }) => {
    const state = getState()
    
    switch (input.action) {
      case 'increment':
        setState({ count: state.count + 1 })
        return `Counter: ${state.count + 1}`
      case 'get':
        return `Counter: ${state.count}`
      case 'reset':
        setState({ count: 0 })
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
  execute: async ({ input }) => {
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
  execute: async ({ input }) => {
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
const prodNotifyTool = NotifyTool.implement({
  execute: async ({ input }) => {
    await notificationService.send(input.channel, input.message)
    return `Sent to ${input.channel}`
  }
})

// Implementation for testing
const testNotifyTool = NotifyTool.implement({
  execute: async ({ input }) => {
    console.log(`[TEST] Would send to ${input.channel}: ${input.message}`)
    return `[TEST] Would send to ${input.channel}`
  }
})
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
  execute: async ({ input }) => {
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
  execute: async ({ input }) => {
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
execute: async ({ input }) => {
  if (input.env === 'production' && !process.env.PROD_DEPLOY_KEY) {
    throw new Error('Missing PROD_DEPLOY_KEY - cannot deploy to production')
  }
  // ...
}
```

## Tool Context

The execute function receives a context object:

```ts
execute: async ({ input, toolUseId, getState, setState, updateState, runSubagent }) => {
  // input: Validated input from the model
  // toolUseId: Unique ID for this tool call
  // getState: Get tool state
  // setState: Replace tool state
  // updateState: Partial update to state
  // runSubagent: Spawn a subagent
}
```

## Best Practices

1. **Clear descriptions**: Help the model understand when to use the tool
2. **Validate thoroughly**: Use Zod for input validation
3. **Return useful errors**: Don't just throw, explain what went wrong
4. **Keep it focused**: One tool, one purpose
5. **Consider state**: Use state for tools that need to track information
6. **Test independently**: Tools should be testable outside the agent
