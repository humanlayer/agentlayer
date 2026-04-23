# Token Usage

Track token consumption and estimate costs across agent runs.

## TokenUsageAccumulator

Accumulate token usage across multiple requests:

```ts
import { TokenUsageAccumulator, getModelKey, extractUsage } from '@humanlayer/agentlayer-core'

const accumulator = new TokenUsageAccumulator()

// Add usage from each request (two separate arguments: modelKey and usage)
accumulator.add('anthropic/claude-sonnet-4-20250514', {
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 100,
  cacheWriteTokens: 200,
  reasoningTokens: 0
})

// Get a snapshot of all usage
const usage = accumulator.snapshot()
console.log(usage.totals)
// {
//   inputTokens: 1000,
//   outputTokens: 500,
//   cacheReadTokens: 100,
//   cacheWriteTokens: 200,
//   reasoningTokens: 0,
//   estimatedCostUsd: undefined
// }

// Get per-model breakdown
console.log(usage.byModel)
// { 'anthropic/claude-sonnet-4-20250514': { inputTokens: 1000, ... } }
```

### With Cost Estimation

Pass a pricing lookup function to enable cost estimation:

```ts
import { TokenUsageAccumulator, type ModelPricing } from '@humanlayer/agentlayer-core'

const pricing: Record<string, ModelPricing> = {
  'anthropic/claude-sonnet-4-20250514': {
    input: 3.00,    // $3 per 1M input tokens
    output: 15.00,  // $15 per 1M output tokens
    cacheRead: 0.30,
    cacheWrite: 3.75
  }
}

const accumulator = new TokenUsageAccumulator((modelKey) => pricing[modelKey])

accumulator.add('anthropic/claude-sonnet-4-20250514', {
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 100,
  cacheWriteTokens: 200,
  reasoningTokens: 0
})

const usage = accumulator.snapshot()
console.log(usage.totals.estimatedCostUsd) // Cost calculated automatically
```

## Extracting Usage

### extractUsage()

Extract usage from AI SDK's `LanguageModelUsage` into our flat structure:

```ts
import { extractUsage } from '@humanlayer/agentlayer-core'
import type { LanguageModelUsage } from 'ai'

// LanguageModelUsage from the AI SDK
const sdkUsage: LanguageModelUsage = {
  inputTokens: 1000,
  outputTokens: 500,
  inputTokenDetails: {
    cacheReadTokens: 100,
    cacheWriteTokens: 200
  },
  outputTokenDetails: {
    reasoningTokens: 50
  }
}

const usage = extractUsage(sdkUsage)
// {
//   inputTokens: 1000,
//   outputTokens: 500,
//   cacheReadTokens: 100,
//   cacheWriteTokens: 200,
//   reasoningTokens: 50
// }
```

## Types

### TokenUsage

Aggregated usage with per-model breakdown and totals:

```ts
interface TokenUsage {
  byModel: Record<string, ModelTokenUsage>
  totals: TokenTotals
}
```

### TokenTotals

Accumulated totals (extends `ModelTokenUsage`):

```ts
interface TokenTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedCostUsd: number | undefined
}
```

### ModelTokenUsage

Usage for a specific model:

```ts
interface ModelTokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  estimatedCostUsd: number | undefined
}
```

### TokenUsageEvent

Event emitted during agent runs:

```ts
interface TokenUsageEvent {
  model: string
  usage: Omit<ModelTokenUsage, 'estimatedCostUsd'>
  contextWindowTokens: number
  contextWindowLimit?: number
}
```

## Model Pricing

### getModelKey()

Build a model key from a `LanguageModel` instance or string:

```ts
import { getModelKey } from '@humanlayer/agentlayer-core'

// When passed a string, returns it as-is
getModelKey('claude-sonnet-4-20250514')  // 'claude-sonnet-4-20250514'

// When passed a LanguageModel, combines provider and modelId
getModelKey(model)  // 'anthropic/claude-sonnet-4-20250514'
```

### ModelPricing

```ts
interface ModelPricing {
  input: number       // Cost per 1M input tokens
  output: number      // Cost per 1M output tokens
  cacheRead?: number  // Cost per 1M cache read tokens
  cacheWrite?: number // Cost per 1M cache write tokens
}
```

## Usage in Agent Runs

The agent emits usage events you can collect:

```ts
import { TokenUsageAccumulator, extractUsage, getModelKey } from '@humanlayer/agentlayer-core'

const accumulator = new TokenUsageAccumulator()

for await (const event of agent.run({ state })) {
  if (event.type === 'tokenUsage') {
    accumulator.add(event.usage.model, event.usage.usage)
  }
}

const usage = accumulator.snapshot()
console.log('Input tokens:', usage.totals.inputTokens)
console.log('Output tokens:', usage.totals.outputTokens)
```

Or access from the run result:

```ts
const run = agent.run('...')
for await (const event of run) { ... }

const result = await run.result
console.log('Input tokens:', result.tokenUsage.totals.inputTokens)
```
