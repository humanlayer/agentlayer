import { describe, it } from '@effect/vitest'
import { Effect, Either } from 'effect'
import z from 'zod'
import { ToolInputZodError } from '../../src/tools'
import { decodeToolInput } from '../../src/tools/input-validation'

describe('Tool input validation', () => {
	const schema = z.object({ firstname: z.string(), lastname: z.string() })

	it.effect('Schema validation passes when schema is satisfied', ({ expect }) =>
		Effect.gen(function* () {
			const result = yield* decodeToolInput(
				schema,
				{ firstname: 'kyle', lastname: 'mistele' },
				{ toolCallId: 'abc', toolName: 'fake' },
			)
			expect(result).toHaveProperty('firstname')
			expect(result).toHaveProperty('lastname')
			expect(result.firstname).toBe('kyle')
			expect(result.lastname).toBe('mistele')
		}),
	)

	it.effect.fails('Schema validation fails when schema is not satisfied', ({ expect }) =>
		Effect.gen(function* () {
			const result = yield* decodeToolInput(
				schema,
				{ firstname: 'kyle', middlename: 'mistele' },
				{ toolCallId: 'abc', toolName: 'fake' },
			)
			expect(result).toHaveProperty('firstname')
			expect(result).toHaveProperty('lastname')
			expect(result.firstname).toBe('kyle')
			expect(result.lastname).toBe('mistele')
		}),
	)

	it.effect('Schema validation fails with correct error when schema is not satisfies', ({ expect }) =>
		Effect.gen(function* () {
			const result = yield* Effect.either(
				decodeToolInput(
					schema,
					{ firstname: 'kyle', middlename: 'mistele' },
					{ toolCallId: 'abc', toolName: 'fake' },
				),
			)
			expect(Either.isLeft(result)).toBe(true) // left channel of the either means error
			if (Either.isLeft(result)) {
				expect(result.left).toBeInstanceOf(ToolInputZodError)
			}
		}),
	)
})
