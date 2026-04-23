# Building Your First Agent

This guide walks through creating a coding agent from scratch.

## Prerequisites

```bash
bun add @humanlayer/agentlayer-core @humanlayer/agentlayer-filesystem
```

You'll also need an Anthropic API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

## Step 1: Create the Agent

```ts
import { Agent, maxSteps } from '@humanlayer/agentlayer-core'
import {
  createClaudeCodingAgentToolset,
  createAgentSystemPrompt,
  createAgentFilesystemHooks
} from '@humanlayer/agentlayer-filesystem'

const cwd = process.cwd()

async function main() {
  // Create tools
  const tools = await createClaudeCodingAgentToolset({ cwd })
  
  // Create system prompt
  const system = await createAgentSystemPrompt({
    cwd,
    model: 'claude'
  })
  
  // Create hooks
  const hooks = createAgentFilesystemHooks({ cwd })
  
  // Build the agent
  const agent = new Agent({
    model: 'claude-sonnet-4-20250514',
    tools,
    system,
    hooks,
    stopWhen: [maxSteps(50)]
  })
  
  // Run it
  for await (const event of agent.run('List the files in the current directory')) {
    if (event.type === 'text') {
      process.stdout.write(event.content)
    }
  }
}

main()
```

## Step 2: Handle Events

The agent emits events as it runs:

```ts
for await (const event of agent.run(prompt)) {
  switch (event.type) {
    case 'text':
      // Assistant text output
      process.stdout.write(event.content)
      break
      
    case 'tool_use':
      // Tool is being called
      console.log(`\n[Tool: ${event.toolName}]`)
      break
      
    case 'tool_result':
      // Tool completed
      console.log(`[Result: ${event.result.slice(0, 100)}...]`)
      break
      
    case 'thinking':
      // Model thinking (extended thinking models)
      console.log(`[Thinking: ${event.content}]`)
      break
      
    case 'usage':
      // Token usage
      console.log(`[Tokens: ${event.usage.input_tokens} in, ${event.usage.output_tokens} out]`)
      break
      
    case 'finish':
      // Agent finished
      console.log(`\n[Finished: ${event.reason}]`)
      break
  }
}
```

## Step 3: Add Approval for Dangerous Operations

```ts
import { createApprovalHook, hookNext, hookAsk } from '@humanlayer/agentlayer-core'

const requireWriteApproval = createApprovalHook(async (ctx) => {
  if (ctx.tool.name === 'Write' || ctx.tool.name === 'Edit') {
    return hookAsk({
      message: `Allow ${ctx.tool.name} to ${ctx.input.file_path}?`,
      toolUseId: ctx.toolUseId
    })
  }
  return hookNext()
})

const agent = new Agent({
  // ...
  hooks: {
    ...hooks,
    approval: [requireWriteApproval]
  }
})
```

## Step 4: Handle Approval Requests

```ts
import { withApprovals } from '@humanlayer/agentlayer-core'
import * as readline from 'readline'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

async function runWithApproval(agent: Agent, prompt: string) {
  let state = undefined
  
  while (true) {
    const run = agent.run(prompt, { state })
    
    for await (const event of run) {
      if (event.type === 'text') {
        process.stdout.write(event.content)
      }
    }
    
    const result = await run.result
    
    if (result.finishReason !== 'approval_required') {
      break
    }
    
    // Get pending approvals
    const pending = getAllPendingApprovals(result.state)
    
    for (const approval of pending) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${approval.message} (y/n): `, resolve)
      })
      
      approval.decision = answer.toLowerCase() === 'y' ? 'approve' : 'deny'
    }
    
    // Resume with approvals
    state = withApprovals(result.state, pending)
    prompt = ''  // Empty prompt to continue
  }
  
  rl.close()
}
```

## Step 5: Add Custom Tools

```ts
import { defineTool } from '@humanlayer/agentlayer-core'
import { z } from 'zod'

const deployTool = defineTool({
  name: 'deploy',
  description: 'Deploy the application to production',
  input: z.object({
    environment: z.enum(['staging', 'production']),
    version: z.string().optional()
  }),
  execute: async ({ input }) => {
    // Your deployment logic
    return `Deployed to ${input.environment}`
  }
})

const tools = [
  ...await createClaudeCodingAgentToolset({ cwd }),
  deployTool
]
```

## Complete Example

```ts
import { Agent, maxSteps, getAllPendingApprovals, withApprovals } from '@humanlayer/agentlayer-core'
import {
  createClaudeCodingAgentToolset,
  createAgentSystemPrompt,
  createAgentFilesystemHooks
} from '@humanlayer/agentlayer-filesystem'

const cwd = process.cwd()

async function main() {
  const agent = new Agent({
    model: 'claude-sonnet-4-20250514',
    tools: await createClaudeCodingAgentToolset({ cwd }),
    system: await createAgentSystemPrompt({ cwd, model: 'claude' }),
    hooks: createAgentFilesystemHooks({ cwd }),
    stopWhen: [maxSteps(50)]
  })

  for await (const event of agent.run('Create a hello world TypeScript file')) {
    if (event.type === 'text') {
      process.stdout.write(event.content)
    }
  }
}

main()
```

## Next Steps

- [Custom Tools](./custom-tools) - Build your own tools
- [Hook Patterns](./hook-patterns) - Add validation, logging, and approval
- [Multi-Model Support](./multi-model) - Use different LLM providers
