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
  
  // Create initial state with the prompt
  const state = {
    messages: [{ role: 'user' as const, content: 'List the files in the current directory' }]
  }
  
  // Run it
  for await (const event of agent.run({ state, stream: true })) {
    if (event.type === 'textDelta') {
      process.stdout.write(event.text)
    }
  }
}

main()
```

## Step 2: Handle Events

The agent emits events as it runs. Use `stream: true` in the run options to receive streaming events:

```ts
const state = {
  messages: [{ role: 'user' as const, content: prompt }]
}

for await (const event of agent.run({ state, stream: true })) {
  switch (event.type) {
    case 'textDelta':
      // Streaming text output
      process.stdout.write(event.text)
      break
      
    case 'textStart':
      // Text block started
      break
      
    case 'textEnd':
      // Text block completed
      break
      
    case 'toolInputStart':
      // Tool is being called
      console.log(`\n[Tool: ${event.toolName}]`)
      break
      
    case 'toolInputDelta':
      // Tool input streaming
      break
      
    case 'toolInputEnd':
      // Tool input complete
      break
      
    case 'reasoningDelta':
      // Model reasoning (extended thinking models)
      console.log(`[Reasoning: ${event.text}]`)
      break
      
    case 'tokenUsage':
      // Token usage
      console.log(`[Tokens: ${event.usage.usage.inputTokens} in, ${event.usage.usage.outputTokens} out]`)
      break
      
    case 'stepFinish':
      // Step finished
      console.log(`\n[Step finished: ${event.finishReason}]`)
      break
  }
}
```

## Step 3: Add Approval for Dangerous Operations

```ts
import { createApprovalHook } from '@humanlayer/agentlayer-core'

// Get references to the tools you want to gate
const { Write, Edit } = tools

// createApprovalHook requires a tool (or array of tools) as the first argument
const requireWriteApproval = createApprovalHook([Write, Edit], async (ctx) => {
  // Use ctx.ask() to request approval - it takes ApprovalRequestData
  return ctx.ask({
    message: `Allow ${ctx.tool.name} to ${ctx.input.file_path}?`
  })
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
import { withApprovals, getAllPendingApprovals, type ApprovalDecision } from '@humanlayer/agentlayer-core'
import * as readline from 'readline'

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

async function runWithApproval(agent: Agent, prompt: string) {
  let state = {
    messages: [{ role: 'user' as const, content: prompt }]
  }
  
  while (true) {
    const run = agent.run({ state, stream: true })
    
    for await (const event of run) {
      if (event.type === 'textDelta') {
        process.stdout.write(event.text)
      }
    }
    
    const result = await run.result
    
    // Note: finishReason uses camelCase
    if (result.finishReason !== 'approvalRequired') {
      break
    }
    
    // getAllPendingApprovals returns Array<{ path: AgentPath; pending: PendingToolCall }>
    const pendingApprovals = getAllPendingApprovals(result.state)
    const decisions: ApprovalDecision[] = []
    
    for (const { pending } of pendingApprovals) {
      const answer = await new Promise<string>((resolve) => {
        rl.question(`${pending.approval.message} (y/n): `, resolve)
      })
      
      // ApprovalDecision uses { toolCallId, approved: true/false }
      if (answer.toLowerCase() === 'y') {
        decisions.push({ toolCallId: pending.toolCallId, approved: true })
      } else {
        decisions.push({ toolCallId: pending.toolCallId, approved: false })
      }
    }
    
    // Resume with approvals
    state = withApprovals(result.state, decisions)
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

  // Create initial state with the user message
  const state = {
    messages: [{ role: 'user' as const, content: 'Create a hello world TypeScript file' }]
  }

  for await (const event of agent.run({ state, stream: true })) {
    if (event.type === 'textDelta') {
      process.stdout.write(event.text)
    }
  }
}

main()
```

## Next Steps

- [Custom Tools](./custom-tools) - Build your own tools
- [Hook Patterns](./hook-patterns) - Add validation, logging, and approval
- [Multi-Model Support](./multi-model) - Use different LLM providers
