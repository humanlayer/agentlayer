# Multi-Model Support

AgentLayer supports multiple LLM providers through the AI SDK.

## Supported Providers

| Provider | Model Examples |
|----------|---------------|
| Anthropic | `claude-sonnet-4-20250514`, `claude-opus-4-20250514` |
| OpenAI | `gpt-4o`, `gpt-4-turbo`, `o1-preview` |
| Google | `gemini-2.0-flash`, `gemini-1.5-pro` |

## Basic Usage

The `model` property in `AgentConfig` expects a `LanguageModel` instance from the AI SDK, not a string. Use provider functions like `anthropic()`, `openai()`, or `google()` to create model instances:

```ts
import { Agent } from '@humanlayer/agentlayer-core'
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { google } from '@ai-sdk/google'

// Anthropic Claude
const claudeAgent = new Agent({
  model: anthropic('claude-sonnet-4-20250514'),
  tools: [...],
  system: '...'
})

// OpenAI GPT-4
const openaiAgent = new Agent({
  model: openai('gpt-4o'),
  tools: [...],
  system: '...'
})

// Google Gemini
const geminiAgent = new Agent({
  model: google('gemini-2.0-flash'),
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

Use `buildCodingProviderOptions` to get model-appropriate provider options. The function takes a model (either a `LanguageModel` instance or a string model ID) and returns optimized provider options for that model family:

```ts
import { buildCodingProviderOptions } from '@humanlayer/agentlayer-core/prompts'
import { anthropic } from '@ai-sdk/anthropic'

const model = anthropic('claude-sonnet-4-20250514')

const agent = new Agent({
  model,
  tools: [...],
  system: '...',
  providerOptions: buildCodingProviderOptions(model)
})
```

This automatically configures model-specific options like:
- **Anthropic**: Extended thinking (adaptive for 4.6+, enabled with budget for 4.5), cache control
- **OpenAI**: Reasoning effort, reasoning summary, store settings

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
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { google } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'

function getModel(modelId: string): LanguageModel {
  if (modelId.startsWith('claude') || modelId.startsWith('anthropic')) {
    return anthropic(modelId)
  }
  if (modelId.startsWith('gpt') || modelId.startsWith('o1') || modelId.startsWith('o3')) {
    return openai(modelId)
  }
  if (modelId.startsWith('gemini')) {
    return google(modelId)
  }
  throw new Error(`Unknown model: ${modelId}`)
}

async function createAgentForModel(modelId: string) {
  const model = getModel(modelId)
  const family = detectModelFamily(model)
  
  const toolsetFactory = family === 'codex' || family === 'openai'
    ? createCodexCodingAgentToolset
    : createClaudeCodingAgentToolset
  
  return new Agent({
    model,
    tools: await toolsetFactory({ cwd: process.cwd() }),
    system: await createAgentSystemPrompt({
      cwd: process.cwd(),
      model: family
    })
  })
}

// Usage
const agent = await createAgentForModel(process.env.MODEL || 'claude-sonnet-4-20250514')
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
import { anthropic } from '@ai-sdk/anthropic'

// Use cheaper model for exploration
const explorerAgent = new Agent({
  model: anthropic('claude-haiku-3-20240307'),
  tools: [globTool, grepTool, readTool],
  system: 'You explore codebases to find relevant files.'
})

// Use capable model for implementation
const implementerAgent = new Agent({
  model: anthropic('claude-sonnet-4-20250514'),
  tools: fullToolset,
  system: 'You implement code changes.'
})
```

## Fallback Models

```ts
import { anthropic } from '@ai-sdk/anthropic'
import { openai } from '@ai-sdk/openai'
import { google } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'

async function runWithFallback(prompt: string) {
  const models: LanguageModel[] = [
    anthropic('claude-sonnet-4-20250514'),
    openai('gpt-4o'),
    google('gemini-1.5-pro')
  ]
  
  for (const model of models) {
    try {
      const agent = new Agent({ model, tools, system })
      const run = agent.run({ state: { messages: [{ role: 'user', content: prompt }] } })
      
      for await (const event of run) {
        // ...
      }
      
      return await run.result
    } catch (error) {
      console.error(`Model failed:`, error.message)
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
