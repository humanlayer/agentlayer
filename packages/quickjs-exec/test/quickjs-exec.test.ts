import { describe, expect, test } from 'bun:test'
import { QuickJsExecutionError, withAsyncQuickJsMode, withQuickJsMode } from '../src'

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

	test('script can return final parenthesized object expression', async () => {
		await withQuickJsMode({}, ({ run }) => {
			const result = run<{ ok: boolean; value: number }>(`
				const value = 20 + 22
				;({ ok: true, value })
			`)

			expect(result).toEqual({ ok: true, value: 42 })
		})
	})

	test('runWithConsole captures logs and return value', async () => {
		await withQuickJsMode({}, ({ runWithConsole }) => {
			const result = runWithConsole<{ ok: boolean }>(`
				console.log('created', { id: 'n2', kind: 'element' })
				;({ ok: true })
			`)

			expect(result).toEqual({
				ok: true,
				value: { ok: true },
				console: [
					{
						level: 'log',
						args: ['created', { id: 'n2', kind: 'element' }],
						text: 'created {"id":"n2","kind":"element"}',
					},
				],
			})
		})
	})

	test('runWithConsole captures logs before runtime errors', async () => {
		await withQuickJsMode({}, ({ runWithConsole }) => {
			const result = runWithConsole(`
				console.log('before failure', { step: 1 })
				missingReference
			`)

			expect(result.ok).toBe(false)
			if (result.ok) throw new Error('Expected failure')
			expect(result.error.name).toBe('ReferenceError')
			expect(result.error.message).toContain('missingReference')
			expect(result.console).toEqual([
				{
					level: 'log',
					args: ['before failure', { step: 1 }],
					text: 'before failure {"step":1}',
				},
			])
		})
	})

	test('runWithConsole captures empty logs for syntax errors', async () => {
		await withQuickJsMode({}, ({ runWithConsole }) => {
			const result = runWithConsole(`
				console.log('not reached')
				const broken = { index 0 }
			`)

			expect(result.ok).toBe(false)
			if (result.ok) throw new Error('Expected failure')
			expect(result.error.name).toBe('SyntaxError')
			expect(result.error.codeFrame).toContain('index 0')
			expect(result.console).toEqual([])
		})
	})

	test('runWithConsole clears logs between runs', async () => {
		await withQuickJsMode({}, ({ runWithConsole }) => {
			const first = runWithConsole(`console.log('first')`)
			const second = runWithConsole(`console.log('second')`)

			expect(first.console.map((entry) => entry.text)).toEqual(['first'])
			expect(second.console.map((entry) => entry.text)).toEqual(['second'])
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

	test('async runWithConsole captures logs and return value', async () => {
		await withAsyncQuickJsMode(
			{
				addAsync: async (a, b) => (a as number) + (b as number),
			},
			async ({ runWithConsole }) => {
				const result = await runWithConsole<{ sum: number }>(`
					console.info('before async')
					;({ sum: bindings.addAsync(20, 22) })
				`)

				expect(result).toEqual({
					ok: true,
					value: { sum: 42 },
					console: [{ level: 'info', args: ['before async'], text: 'before async' }],
				})
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

	test('throws concise QuickJS syntax errors with code frame', async () => {
		await expect(
			withQuickJsMode({}, ({ run }) =>
				run(`
					const ok = 1
					const broken = { node: bindings.root(), index 0 }
					broken
				`),
			),
		).rejects.toThrow(QuickJsExecutionError)

		try {
			await withQuickJsMode({}, ({ run }) =>
				run(`
					const ok = 1
					const broken = { node: bindings.root(), index 0 }
					broken
				`),
			)
		} catch (error) {
			expect(error).toBeInstanceOf(QuickJsExecutionError)
			expect((error as Error).message).toContain('SyntaxError: expecting')
			expect((error as Error).message).toContain('at eval.js:3')
			expect((error as Error).message).toContain('> 3 |')
			expect((error as Error).message).toContain('index 0')
		}
	})

	test('prints QuickJsExecutionError field shapes for learning', async () => {
		const cases = [
			{
				label: 'syntax error',
				code: `
					const ok = 1
					const broken = { node: bindings.root(), index 0 }
					broken
				`,
			},
			{
				label: 'runtime reference error',
				code: `
					const ok = 1
					missingReference.property
				`,
			},
		]

		const examples: unknown[] = []

		for (const example of cases) {
			try {
				await withQuickJsMode({}, ({ run }) => run(example.code))
			} catch (error) {
				expect(error).toBeInstanceOf(QuickJsExecutionError)

				const quickJsError = error as QuickJsExecutionError & { cause?: unknown }
				const cause = quickJsError.cause
				const causeRecord = cause && typeof cause === 'object' ? (cause as Record<string, unknown>) : undefined
				const ownProperties = Object.fromEntries(
					Object.getOwnPropertyNames(quickJsError).map((name) => [
						name,
						(quickJsError as unknown as Record<string, unknown>)[name],
					]),
				)

				examples.push({
					label: example.label,
					name: quickJsError.name,
					message: quickJsError.message,
					details: quickJsError.details,
					cause: causeRecord
						? {
								name: causeRecord.name,
								message: causeRecord.message,
								fileName: causeRecord.fileName,
								lineNumber: causeRecord.lineNumber,
								columnNumber: causeRecord.columnNumber,
							}
						: cause,
					ownProperties,
					stack: quickJsError.stack,
				})
			}
		}

		expect(examples).toHaveLength(cases.length)
		console.log('QuickJsExecutionError examples:', JSON.stringify(examples, null, 2))
	})
})
