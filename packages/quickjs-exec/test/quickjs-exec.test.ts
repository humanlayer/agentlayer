import { describe, expect, test } from 'bun:test'
import { withAsyncQuickJsMode, withQuickJsMode } from '../src'

describe('quickjs-exec', () => {
	test('runs sync code with sync host bindings', async () => {
		await withQuickJsMode(
			{
				add: (a, b) => (a as number) + (b as number),
			},
			({ run }) => {
				const result = run<{ sum: number }>(`
					({ sum: bindings.add(20, 22) })
				`)

				expect(result).toEqual({ sum: 42 })
			},
		)
	})

	test('script with no final expression does not throw and returns undefined', async () => {
		await withQuickJsMode({}, ({ run }) => {
			const result = run(`const x = 2`)

			expect(result).toBeUndefined()
		})
	})

	test('runs asyncified host bindings', async () => {
		await withAsyncQuickJsMode(
			{
				addAsync: async (a, b) => (a as number) + (b as number),
			},
			async ({ run }) => {
				const result = await run<{ sum: number }>(`
					({ sum: bindings.addAsync(20, 22) })
				`)

				expect(result).toEqual({ sum: 42 })
			},
		)
	})

	test('sync harness rejects async binding functions', async () => {
		await expect(
			withQuickJsMode(
				{
					asyncBinding: async () => 42,
				},
				({ run }) => run(`bindings.asyncBinding()`),
			),
		).rejects.toThrow('Async binding asyncBinding used with withQuickJsMode')
	})
})
