import { Data } from "effect"
import type { AgentState } from "@humanlayer/agentlayer-core"

export class LLMStreamError extends Data.TaggedError("LLMStreamError")<{
  message: string
  cause?: unknown
  retryable: boolean
}> {}

export class LLMRateLimitError extends Data.TaggedError("LLMRateLimitError")<{
  message: string
  retryAfterMs?: number
}> {}

export class LLMAuthError extends Data.TaggedError("LLMAuthError")<{
  message: string
}> {}

export class LLMAbortedError extends Data.TaggedError("LLMAbortedError")<{}> {}

export class AgentInterruptedError extends Data.TaggedError("AgentInterruptedError")<{
  state: AgentState
}> {}
