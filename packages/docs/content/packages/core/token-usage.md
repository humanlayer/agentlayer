# Token Usage

Track token consumption and estimate costs across agent runs.

## TokenUsageAccumulator

Accumulate token usage across multiple requests:

```ts
import { TokenUsageAccumulator } from '@humanlayer/agentlayer-core'

const accumulator = new TokenUsageAccumulator()

// Add usage from each request
accumulator.add({
  model: 'claude-sonnet-4-20250514',
  input_tokens: 1000,
  output_tokens: 500,
  cache_creation_input_tokens: 200,
  cache_read_input_tokens: 100
})

// Get totals
const totals = accumulator.getTotals()
console.log(totals)
// {
//   input_tokens: 1000,
//   output_tokens: 500,
//   cache_creation_input_tokens: 200,
//   cache_read_input_tokens: 100,
//   total_tokens: 1500
// }

// Get per-model breakdown
const byModel = accumulator.getByModel()
// Map<string, TokenTotals>
```

## Extracting Usage

### extractUsage()

Extract usage from API responses:

```ts
import { extractUsage } from '@humanlayer/agentlayer-core'

const response = await anthropic.messages.create({ ... })
const usage = extractUsage(response)
// { input_tokens: 1000, output_tokens: 500, ... }
```

## Types

### TokenUsage

Raw usage from a single request:

```ts
interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}
```

### TokenTotals

Accumulated totals:

```ts
interface TokenTotals {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  total_tokens: number
}
```

### ModelTokenUsage

Usage tied to a specific model:

```ts
interface ModelTokenUsage extends TokenUsage {
  model: string
}
```

### TokenUsageEvent

Event emitted during agent runs:

```ts
interface TokenUsageEvent {
  type: 'usage'
  usage: TokenUsage
  model: string
}
```

## Model Pricing

### getModelKey()

Normalize model IDs for pricing lookup:

```ts
import { getModelKey } from '@humanlayer/agentlayer-core'

getModelKey('claude-sonnet-4-20250514')  // 'claude-sonnet-4'
getModelKey('gpt-4o-2024-05-13')         // 'gpt-4o'
```

### ModelPricing

```ts
interface ModelPricing {
  input: number           // Cost per 1M input tokens
  output: number          // Cost per 1M output tokens
  cacheCreation?: number  // Cost per 1M cache creation tokens
  cacheRead?: number      // Cost per 1M cache read tokens
}
```

## Usage in Agent Runs

The agent emits usage events you can collect:

```ts
const accumulator = new TokenUsageAccumulator()

for await (const event of agent.run('...')) {
  if (event.type === 'usage') {
    accumulator.add({
      model: 'claude-sonnet-4-20250514',
      ...event.usage
    })
  }
}

console.log('Total tokens:', accumulator.getTotals().total_tokens)
```

Or access from the run result:

```ts
const run = agent.run('...')
for await (const event of run) { ... }

const result = await run.result
if (result.usage) {
  console.log('Input tokens:', result.usage.input_tokens)
}
```

## Cost Estimation

```ts
const totals = accumulator.getTotals()
const pricing: ModelPricing = {
  input: 3.00,    // $3 per 1M input tokens
  output: 15.00,  // $15 per 1M output tokens
}

const cost = 
  (totals.input_tokens / 1_000_000) * pricing.input +
  (totals.output_tokens / 1_000_000) * pricing.output

console.log(`Estimated cost: $${cost.toFixed(4)}`)
```
