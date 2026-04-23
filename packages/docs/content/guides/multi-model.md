# Multi-Model Support

AgentLayer supports multiple LLM providers through the AI SDK.

## Supported Providers

| Provider | Model Examples |
|----------|---------------|
| Anthropic | `claude-sonnet-4-20250514`, `claude-opus-4-20250514` |
| OpenAI | `gpt-4o`, `gpt-4-turbo`, `o1-preview` |
| Google | `gemini-2.0-flash`, `gemini-1.5-pro` |

## Basic Usage

```ts
import { Agent } from '@humanlayer/agentlayer-core'

// Anthropic Claude
const claudeAgent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: [...],
  system: '...'
})

// OpenAI GPT-4
const openaiAgent = new Agent({
  model: 'gpt-4o',
  tools: [...],
  system: '...'
})

// Google Gemini
const geminiAgent = new Agent({
  model: 'gemini-2.0-flash',
  tools: [...],
  system: '...'
})
```

## Model-Specific System Prompts

Use the prompt utilities to get optimized prompts:

```ts
import { getSystemPromptForModel, detectModelFamily } from '@humanlayer/agentlayer-core/prompts'

// Auto-detect model family
const family = detectModelFamily('claude-sonnet-4-20250514')  // 'claude'

// Get optimized prompt
const systemPrompt = getSystemPromptForModel(family)
```

Or use `createAgentSystemPrompt` with model detection:

```ts
import { createAgentSystemPrompt } from '@humanlayer/agentlayer-filesystem'

const system = await createAgentSystemPrompt({
  cwd: process.cwd(),
  model: 'claude'  // or 'openai', 'gemini', 'codex'
})
```

## Provider Options

Pass provider-specific options:

```ts
import { buildCodingProviderOptions } from '@humanlayer/agentlayer-core/prompts'

const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: [...],
  system: '...',
  providerOptions: buildCodingProviderOptions({
    temperature: 0.7,
    maxTokens: 4096
  })
})
```

## Choosing Tools by Model

Some models work better with different tool configurations:

```ts
import {
  createClaudeCodingAgentToolset,
  createCodexCodingAgentToolset
} from '@humanlayer/agentlayer-filesystem'

// Claude: uses Edit tool for string replacement
const claudeTools = await createClaudeCodingAgentToolset({ cwd })

// Codex/OpenAI: uses ApplyPatch for unified diffs
const codexTools = await createCodexCodingAgentToolset({ cwd })
```

## Dynamic Model Selection

```ts
function createAgentForModel(modelId: string) {
  const family = detectModelFamily(modelId)
  
  const toolsetFactory = family === 'codex' || family === 'openai'
    ? createCodexCodingAgentToolset
    : createClaudeCodingAgentToolset
  
  return new Agent({
    model: modelId,
    tools: await toolsetFactory({ cwd: process.cwd() }),
    system: await createAgentSystemPrompt({
      cwd: process.cwd(),
      model: family
    })
  })
}

// Usage
const agent = createAgentForModel(process.env.MODEL || 'claude-sonnet-4-20250514')
```

## Model Comparison

| Feature | Claude | GPT-4 | Gemini |
|---------|--------|-------|--------|
| Extended thinking | Yes | No | No |
| Tool use | Excellent | Good | Good |
| Code generation | Excellent | Excellent | Good |
| Long context | 200k | 128k | 1M+ |
| Streaming | Yes | Yes | Yes |

## Cost Optimization

Use different models for different tasks:

```ts
// Use cheaper model for exploration
const explorerAgent = new Agent({
  model: 'claude-haiku-3-20240307',
  tools: [globTool, grepTool, readTool],
  system: 'You explore codebases to find relevant files.'
})

// Use capable model for implementation
const implementerAgent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: fullToolset,
  system: 'You implement code changes.'
})
```

## Fallback Models

```ts
async function runWithFallback(prompt: string) {
  const models = [
    'claude-sonnet-4-20250514',
    'gpt-4o',
    'gemini-1.5-pro'
  ]
  
  for (const model of models) {
    try {
      const agent = new Agent({ model, tools, system })
      const run = agent.run(prompt)
      
      for await (const event of run) {
        // ...
      }
      
      return await run.result
    } catch (error) {
      console.error(`${model} failed:`, error.message)
      continue
    }
  }
  
  throw new Error('All models failed')
}
```

## Environment Variables

Set API keys for each provider:

```bash
# Anthropic
export ANTHROPIC_API_KEY=sk-ant-...

# OpenAI
export OPENAI_API_KEY=sk-...

# Google
export GOOGLE_API_KEY=...
```
