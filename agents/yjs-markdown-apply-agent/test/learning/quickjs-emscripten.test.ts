import { describe, expect, test } from 'bun:test'
import { getQuickJS, newAsyncContext } from 'quickjs-emscripten'
import * as Y from 'yjs'

describe('quickjs-emscripten learning tests', () => {
	test('sync context can evaluate code and read values', async () => {
		const QuickJS = await getQuickJS()
		const vm = QuickJS.newContext()

		try {
			const result = vm.evalCode(`({ answer: 40 + 2 })`)
			const value = vm.unwrapResult(result)

			expect(vm.dump(value)).toEqual({ answer: 42 })
			value.dispose()
		} finally {
			vm.dispose()
		}
	})

	test('sync context can call host functions', async () => {
		const QuickJS = await getQuickJS()
		const vm = QuickJS.newContext()
		let callCount = 0

		try {
			const addHandle = vm.newFunction('add', (aHandle, bHandle) => {
				callCount += 1
				const a = vm.getNumber(aHandle)
				const b = vm.getNumber(bHandle)

				return vm.newNumber(a + b)
			})
			vm.setProp(vm.global, 'add', addHandle)
			addHandle.dispose()

			const result = vm.evalCode(`add(add(1, 1), 40)`)
			const value = vm.unwrapResult(result)

			expect(vm.getNumber(value)).toBe(42)
			expect(callCount).toBe(2)
			value.dispose()
		} finally {
			vm.dispose()
		}
	})

	test('sync host functions can mutate a live Y.XmlFragment', async () => {
		const QuickJS = await getQuickJS()
		const vm = QuickJS.newContext()
		const yDoc = new Y.Doc()
		const fragment = yDoc.getXmlFragment('quickjs-sync-bindings')

		try {
			const pushElementHandle = vm.newFunction('pushElement', (jsonHandle) => {
				const input = JSON.parse(vm.getString(jsonHandle)) as {
					nodeName: string
					text: string
					attributes?: Record<string, string>
				}
				const element = new Y.XmlElement(input.nodeName)
				for (const [name, value] of Object.entries(input.attributes ?? {})) {
					element.setAttribute(name, value)
				}

				const text = new Y.XmlText()
				text.insert(0, input.text)
				element.push([text])
				fragment.push([element])

				return vm.newString(JSON.stringify({ xml: fragment.toJSON(), length: fragment.length }))
			})
			vm.setProp(vm.global, 'pushElementJson', pushElementHandle)
			pushElementHandle.dispose()

			const result = vm.evalCode(`
				JSON.parse(pushElementJson(JSON.stringify({
					nodeName: 'section',
					text: 'Hello from sync QuickJS',
					attributes: { id: 'intro' },
				})))
			`)
			const value = vm.unwrapResult(result)

			expect(vm.dump(value)).toEqual({
				length: 1,
				xml: '<section id="intro">Hello from sync QuickJS</section>',
			})
			expect(fragment.toJSON()).toBe('<section id="intro">Hello from sync QuickJS</section>')
			value.dispose()
		} finally {
			vm.dispose()
		}
	})

	test('sync host functions can return QuickJS promises for awaited bindings', async () => {
		const QuickJS = await getQuickJS()
		const vm = QuickJS.newContext()

		try {
			const asyncAddHandle = vm.newFunction('asyncAdd', (jsonHandle) => {
				const { a, b } = JSON.parse(vm.getString(jsonHandle)) as { a: number; b: number }
				const promise = vm.newPromise()

				queueMicrotask(() => {
					promise.resolve(vm.newString(JSON.stringify({ sum: a + b })))
				})
				promise.settled.then(vm.runtime.executePendingJobs)

				return promise.handle
			})
			vm.setProp(vm.global, 'asyncAddJson', asyncAddHandle)
			asyncAddHandle.dispose()

			const result = vm.evalCode(`
				(async () => {
					const first = JSON.parse(await asyncAddJson(JSON.stringify({ a: 1, b: 1 })))
					const second = JSON.parse(await asyncAddJson(JSON.stringify({ a: first.sum, b: 40 })))

					return second.sum
				})()
			`)
			const promiseHandle = vm.unwrapResult(result)
			const resolvedResult = await vm.resolvePromise(promiseHandle)
			promiseHandle.dispose()
			const value = vm.unwrapResult(resolvedResult)

			expect(vm.getNumber(value)).toBe(42)
			value.dispose()
		} finally {
			vm.dispose()
		}
	})

	test('asyncified host functions are synchronous from QuickJS code', async () => {
		const context = await newAsyncContext()

		try {
			const addHandle = context.newAsyncifiedFunction('add', async (jsonHandle) => {
				const { a, b } = JSON.parse(context.getString(jsonHandle)) as { a: number; b: number }

				return context.newString(JSON.stringify({ sum: a + b }))
			})
			context.setProp(context.global, 'addJson', addHandle)
			addHandle.dispose()

			const result = await context.evalCodeAsync(`
				const first = JSON.parse(addJson(JSON.stringify({ a: 1, b: 1 })))
				const second = JSON.parse(addJson(JSON.stringify({ a: first.sum, b: 40 })))

				second.sum
			`)
			const value = context.unwrapResult(result)

			expect(context.getNumber(value)).toBe(42)
			value.dispose()
		} finally {
			context.dispose()
		}
	})

	test('asyncified host functions can also be used inside settled QuickJS promises', async () => {
		const context = await newAsyncContext()

		try {
			const addHandle = context.newAsyncifiedFunction('add', async (jsonHandle) => {
				const { a, b } = JSON.parse(context.getString(jsonHandle)) as { a: number; b: number }

				return context.newString(JSON.stringify({ sum: a + b }))
			})
			context.setProp(context.global, 'addJson', addHandle)
			addHandle.dispose()

			const result = await context.evalCodeAsync(`
				(async () => {
					const first = JSON.parse(addJson(JSON.stringify({ a: 1, b: 1 })))
					const second = JSON.parse(addJson(JSON.stringify({ a: first.sum, b: 40 })))

					return second.sum
				})()
			`)
			const promiseHandle = context.unwrapResult(result)
			const stateResult = context.getPromiseState(promiseHandle)
			expect(stateResult.type).toBe('fulfilled')
			if (stateResult.type !== 'fulfilled') throw new Error(`Expected fulfilled promise, got ${stateResult.type}`)
			const value = stateResult.value

			expect(context.getNumber(value)).toBe(42)
			value.dispose()
			promiseHandle.dispose()
		} finally {
			context.dispose()
		}
	})
})
