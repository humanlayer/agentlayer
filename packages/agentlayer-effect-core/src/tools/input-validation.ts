import { Effect } from 'effect'
import type { z } from 'zod'
import { SpanName } from '../observability/span-names'
import { ToolInputZodError } from './errors'

/**
 * Effect responsible for parsing / validating tool input with zod since we don't want to force callers to use effect schema
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
		})

		const result = schema.safeParse(input)

		if (!result.success) {
			const error = new ToolInputZodError({
				toolName: meta.toolName,
				toolCallId: meta.toolCallId,
				input,
				error: result.error,
			})

			yield* Effect.logError('tool input validation failed').pipe(
				Effect.annotateLogs({
					'tool.name': meta.toolName,
					'tool.callId': meta.toolCallId,
					'tool.error._tag': error._tag,
					'tool.validation.issues.count': result.error.issues.length,
				}),
			)

			return yield* error
		}

		return result.data
	}).pipe(Effect.withSpan(SpanName.toolValidateInput(meta.toolName)))
}
