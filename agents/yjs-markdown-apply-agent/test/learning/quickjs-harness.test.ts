import { describe, expect, test } from 'bun:test'
import { withAsyncQuickJsMode, withQuickJsMode } from '@humanlayer/quickjs-exec'
import * as Y from 'yjs'

describe('quickjs yxml harness', () => {
	test('sync harness mirrors withCodeMode setup shape', async () => {
		await withQuickJsMode(
			{
				add: (a, b) => (a as number) + (b as number),
			},
			({ run }) => {
				const result = run<{ sum: number }>(`
					({
						sum: bindings.add(20, 22),
					})
				`)

				expect(result).toEqual({ sum: 42 })
			},
		)
	})

	test('script with no final expression does not throw and returns undefined', async () => {
		await withQuickJsMode({}, ({ run }) => {
			const result = run(`
				const x = 2
			`)

			expect(result).toBeUndefined()
		})
	})

	test('async harness supports async host bindings', async () => {
		const doc = new Y.Doc()
		const fragment = doc.getXmlFragment('quickjs-async')

		await withAsyncQuickJsMode(
			{
				addAsync: async (a, b) => (a as number) + (b as number),
				fragmentLength: () => fragment.length,
			},
			async ({ run }) => {
				const result = await run<{ sum: number; length: number }>(`
					({
						sum: bindings.addAsync(20, 22),
						length: bindings.fragmentLength(),
					})
				`)

				expect(result).toEqual({ sum: 42, length: 0 })
			},
		)
	})
})
