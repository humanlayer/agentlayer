import { Effect } from 'effect'
import type { z } from 'zod'
import { SpanName } from '../observability/span-names'
import { ToolInputZodError } from './errors'

/**
 * Effect to parse a tool's input and ensure it's correct
 * @param schema
 * @param input
 * @param meta
 * @returns
 */
export function decodeToolInput<T>(
	schema: z.ZodType<T>,
	input: unknown,
	meta: { toolName: string; toolCallId: string },
): Effect.Effect<T, ToolInputZodError> {
	return Effect.gen(function* () {
		yield* Effect.annotateCurrentSpan({
			'tool.name': meta.toolName,
			'tool.callId': meta.toolCallId,
			'tool.input': input,
		})

		const result = schema.safeParse(input)

		if (!result.success) {
			const error = new ToolInputZodError({
				toolName: meta.toolName,
				toolCallId: meta.toolCallId,
				input,
				error: result.error,
			})

			yield* Effect.log('tool input validation failed').pipe(
				Effect.annotateLogs({
					'tool.name': meta.toolName,
					'tool.callId': meta.toolCallId,
					'tool.validationIssues': result.error.issues,
				}),
			)

			return yield* Effect.fail(error)
		}

		return result.data
	}).pipe(Effect.withSpan(SpanName.toolValidateInput(meta.toolName)))
}
