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

Stop when a specific tool is called, **before** execution. Useful for approval gates where you want to inspect intent without side effects.

```ts
import { toolCalled } from '@humanlayer/agentlayer-core'

toolCalled('finish')           // Stop when 'finish' is called
toolCalled('submit_answer')    // Stop when 'submit_answer' is called
```

### toolCompleted()

Stop when a specific tool completes successfully (non-error result).

```ts
import { toolCompleted } from '@humanlayer/agentlayer-core'

toolCompleted('deploy')        // Stop after 'deploy' succeeds
```

### structuredOutputCalled()

Stop when the structured output tool is called (for agents that produce structured results). This is a convenience wrapper around `toolCalled('structured_output')`.

```ts
import { structuredOutputCalled } from '@humanlayer/agentlayer-core'

structuredOutputCalled()
```

### doomLoop()

Detect and stop when the agent is stuck repeating the same tool call with identical input.

```ts
import { doomLoop } from '@humanlayer/agentlayer-core'

doomLoop()         // Default: 3 identical consecutive calls
doomLoop(5)        // Custom threshold
```

### consecutiveToolFailures()

Stop after consecutive tool failures.

```ts
import { consecutiveToolFailures } from '@humanlayer/agentlayer-core'

consecutiveToolFailures(3)              // Stop after 3 consecutive failures
consecutiveToolFailures(3, 'bash')      // Only count failures for 'bash' tool
```

### totalToolFailures()

Stop after total tool failures (not necessarily consecutive).

```ts
import { totalToolFailures } from '@humanlayer/agentlayer-core'

totalToolFailures(10)                   // Stop after 10 total failures
totalToolFailures(5, 'fetch')           // Only count failures for 'fetch' tool
```

## Creating Custom Stop Conditions

```ts
import type { StopConditionDef, Step } from '@humanlayer/agentlayer-core'

const customStop: StopConditionDef = {
  name: 'too-many-calls',
  timing: 'afterExecution',
  message: 'Too many tool calls',
  check: (steps: Step[]) => {
    const totalCalls = steps.reduce((sum, s) => sum + s.toolCalls.length, 0)
    return totalCalls > 100
  },
  onTriggered: () => {
    console.log('Custom stop condition triggered!')
  }
}
```

## Stop Condition Types

### StopConditionDef

```ts
interface StopConditionDef {
  /** Identifies the condition (e.g. "maxSteps", "toolCalled:deploy") */
  name: string
  /** The predicate; receives the step history and returns true to stop */
  check: (steps: Step[]) => boolean
  /** When to evaluate: before or after tool execution. Defaults to 'afterExecution' */
  timing?: StopTiming
  /** Optional human-readable explanation shown when triggered */
  message?: string
  /** Optional callback fired when this condition triggers the stop */
  onTriggered?: () => void
}
```

### StopTiming

```ts
type StopTiming = 'beforeExecution' | 'afterExecution'
```

- `beforeExecution`: Check after the model generates tool calls, before they run
- `afterExecution`: Check after tool calls have been executed and results recorded (default)

### StopResult

Returned by `shouldStop` when a condition fires, so the caller knows which one.

```ts
interface StopResult {
  /** The name of the condition that triggered the stop */
  name: string
  /** The human-readable message, if the condition provided one */
  message?: string
}
```

### Step

A Step represents one iteration of the agent loop - one model call plus all tool executions that resulted from it.

```ts
interface Step {
  /** The tool calls the model generated during this step */
  toolCalls: Array<TypedToolCall<ToolSet>>
  /** The results of executing each tool call. Empty before execution. */
  toolResults: StepToolResult[]
}

interface StepToolResult {
  toolCallId: string
  toolName: string
  output: string
  isError: boolean
}
```

## shouldStop()

Utility to run all stop conditions:

```ts
import { shouldStop } from '@humanlayer/agentlayer-core'

const result = shouldStop(stopConditions, steps, 'afterExecution')
if (result) {
  console.log('Stopping:', result.name, result.message)
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
  timing: 'afterExecution',
  message: 'Both conditions met',
  check: (steps) => {
    const hasEnoughSteps = steps.length >= 10
    const lastStep = steps[steps.length - 1]
    const hasDoneTool = lastStep?.toolResults.some(tr => tr.toolName === 'done' && !tr.isError)
    return hasEnoughSteps && !!hasDoneTool
  }
}
```
