# Stop Conditions

Stop conditions control when the agent loop terminates. They run after each step and can stop execution based on various criteria.

## Using Stop Conditions

```ts
import { Agent, maxSteps, toolCalled, doomLoop } from '@humanlayer/agentlayer-core'

const agent = new Agent({
  model: 'claude-sonnet-4-20250514',
  tools: [...],
  stopWhen: [
    maxSteps(50),           // Stop after 50 tool calls
    toolCalled('finish'),   // Stop when 'finish' tool is called
    doomLoop()              // Stop if agent is stuck in a loop
  ]
})
```

## Built-in Stop Conditions

### maxSteps()

Stop after a maximum number of steps (tool calls).

```ts
import { maxSteps } from '@humanlayer/agentlayer-core'

maxSteps(50)        // Stop after 50 steps
maxSteps(100)       // Stop after 100 steps
```

### toolCalled()

Stop when a specific tool is called.

```ts
import { toolCalled } from '@humanlayer/agentlayer-core'

toolCalled('finish')           // Stop when 'finish' is called
toolCalled('submit_answer')    // Stop when 'submit_answer' is called
```

### toolCompleted()

Stop when a specific tool completes successfully.

```ts
import { toolCompleted } from '@humanlayer/agentlayer-core'

toolCompleted('deploy')        // Stop after 'deploy' succeeds
```

### structuredOutputCalled()

Stop when the structured output tool is called (for agents that produce structured results).

```ts
import { structuredOutputCalled } from '@humanlayer/agentlayer-core'

structuredOutputCalled()
```

### doomLoop()

Detect and stop when the agent is stuck repeating the same actions.

```ts
import { doomLoop } from '@humanlayer/agentlayer-core'

doomLoop()                     // Default: 3 repeated sequences
doomLoop({ threshold: 5 })     // Custom threshold
```

### consecutiveToolFailures()

Stop after consecutive tool failures.

```ts
import { consecutiveToolFailures } from '@humanlayer/agentlayer-core'

consecutiveToolFailures(3)     // Stop after 3 consecutive failures
```

### totalToolFailures()

Stop after total tool failures (not necessarily consecutive).

```ts
import { totalToolFailures } from '@humanlayer/agentlayer-core'

totalToolFailures(10)          // Stop after 10 total failures
```

## Creating Custom Stop Conditions

```ts
import type { StopConditionDef, Step } from '@humanlayer/agentlayer-core'

const customStop: StopConditionDef = {
  name: 'token-limit',
  when: 'after',  // 'before' or 'after' tool execution
  check: (steps: Step[]) => {
    const totalTokens = steps.reduce((sum, s) => sum + (s.tokens ?? 0), 0)
    if (totalTokens > 100000) {
      return { stop: true, reason: 'Token limit exceeded' }
    }
    return { stop: false }
  }
}
```

## Stop Condition Types

### StopConditionDef

```ts
interface StopConditionDef {
  name: string
  when: StopTiming
  check: (steps: Step[]) => StopResult
}
```

### StopTiming

```ts
type StopTiming = 'before' | 'after'
```

- `before`: Check before tool execution
- `after`: Check after tool execution

### StopResult

```ts
type StopResult = 
  | { stop: false }
  | { stop: true; reason: string }
```

### Step

```ts
interface Step {
  toolName: string
  toolUseId: string
  input: unknown
  result?: StepToolResult
  tokens?: number
  timestamp: number
}

interface StepToolResult {
  success: boolean
  output: string
  error?: string
}
```

## shouldStop()

Utility to run all stop conditions:

```ts
import { shouldStop } from '@humanlayer/agentlayer-core'

const result = shouldStop(stopConditions, steps, 'after')
if (result.stop) {
  console.log('Stopping:', result.reason)
}
```

## Combining Conditions

Stop conditions are OR'd together - any condition can stop the agent:

```ts
const agent = new Agent({
  stopWhen: [
    maxSteps(100),              // OR
    toolCalled('done'),         // OR
    consecutiveToolFailures(3)  // OR
  ]
})
```

To require multiple conditions (AND), create a custom condition:

```ts
const bothConditions: StopConditionDef = {
  name: 'both',
  when: 'after',
  check: (steps) => {
    const hasEnoughSteps = steps.length >= 10
    const hasDoneTool = steps.some(s => s.toolName === 'done')
    
    if (hasEnoughSteps && hasDoneTool) {
      return { stop: true, reason: 'Both conditions met' }
    }
    return { stop: false }
  }
}
```
