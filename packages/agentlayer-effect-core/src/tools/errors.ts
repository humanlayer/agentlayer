import { Data } from 'effect'
import type z from 'zod'
/**
 * Indicates a failure in tool execution
 */
export class ToolExecutionError extends Data.TaggedError('ToolExecutionError')<{
	toolName: string
	toolCallId: string
	cause: unknown
}> {}

/**
 * Tool input fails schema parsing
 */
export class ToolInputZodError extends Data.TaggedError('ToolInputZodError')<{
	toolName: string
	toolCallId: string
	input: unknown
	error: z.ZodError
}> {}

/**
 * Use for when the model cals a non-existend error
 */
export class ToolNotFoundError extends Data.TaggedError('ToolNotFoundError')<{
	toolName: string
	toolCallId: string
	availableTools: ReadonlyArray<string>
}> {}

/**
 * Invalid tool registration e.g. if the tool shadows another tool's name
 */
export class ToolRegistrationError extends Data.TaggedError('ToolRegistrationError')<{
	toolName: string
	reason: string
}> {}
