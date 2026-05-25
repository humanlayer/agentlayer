import { Data } from "effect"

export class HookExecutionError extends Data.TaggedError("HookExecutionError")<{
  hookName: string
  phase: "approval" | "preToolUse" | "postToolUse" | "preRequest"
  cause: unknown
}> {}
