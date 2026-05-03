import { getQuickJS, newAsyncContext, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten'

export type QuickJsBinding = (...args: unknown[]) => unknown | Promise<unknown>
export type QuickJsBindings = Record<string, QuickJsBinding>

export type QuickJsExecutionMode = 'sync' | 'async'

export type QuickJsExec = {
	readonly mode: QuickJsExecutionMode
	run<T = unknown>(code: string): T | Promise<T>
	dispose(): void
}

export type QuickJsSyncExec = QuickJsExec & {
	readonly mode: 'sync'
	run<T = unknown>(code: string): T
}

export type QuickJsAsyncExec = QuickJsExec & {
	readonly mode: 'async'
	run<T = unknown>(code: string): Promise<T>
}

export type WithQuickJsModeCallback<T> = (exec: QuickJsSyncExec) => T | Promise<T>
export type WithAsyncQuickJsModeCallback<T> = (exec: QuickJsAsyncExec) => T | Promise<T>

export async function withQuickJsMode<T>(bindings: QuickJsBindings, cb: WithQuickJsModeCallback<T>): Promise<T> {
	const QuickJS = await getQuickJS()
	const vm = QuickJS.newContext()
	const disposableHandles: QuickJSHandle[] = []

	try {
		installSyncBindings({ vm, bindings, disposableHandles })
		return await cb({
			mode: 'sync',
			run: (code) => runSync<TypedUnknown>(vm, code) as never,
			dispose: () => vm.dispose(),
		})
	} finally {
		disposeHandles(disposableHandles)
		vm.dispose()
	}
}

export async function withAsyncQuickJsMode<T>(
	bindings: QuickJsBindings,
	cb: WithAsyncQuickJsModeCallback<T>,
): Promise<T> {
	const context = await newAsyncContext()
	const disposableHandles: QuickJSHandle[] = []

	try {
		installAsyncifiedBindings({ context, bindings, disposableHandles })
		return await cb({
			mode: 'async',
			run: (code) => runAsync<TypedUnknown>(context, code) as never,
			dispose: () => context.dispose(),
		})
	} finally {
		disposeHandles(disposableHandles)
		context.dispose()
	}
}

type TypedUnknown = unknown

function runSync<T>(vm: QuickJSContext, code: string): T {
	const result = vm.evalCode(code)
	const value = vm.unwrapResult(result)
	try {
		return vm.dump(value) as T
	} finally {
		value.dispose()
	}
}

async function runAsync<T>(context: Awaited<ReturnType<typeof newAsyncContext>>, code: string): Promise<T> {
	const result = await context.evalCodeAsync(code)
	const value = context.unwrapResult(result)
	try {
		return context.dump(value) as T
	} finally {
		value.dispose()
	}
}

function installSyncBindings(input: {
	vm: QuickJSContext
	bindings: QuickJsBindings
	disposableHandles: QuickJSHandle[]
}): void {
	for (const [name, fn] of Object.entries(input.bindings)) {
		const handle = input.vm.newFunction(name, (...args) => {
			const output = fn(...args.map((arg) => input.vm.dump(arg)))
			if (output instanceof Promise) throw new Error(`Async binding ${name} used with withQuickJsMode`)
			return input.vm.newString(JSON.stringify(output ?? null))
		})
		input.vm.setProp(input.vm.global, name, handle)
		input.disposableHandles.push(handle)
	}
	installBindingFacade(input.vm, input.disposableHandles)
}

function installAsyncifiedBindings(input: {
	context: Awaited<ReturnType<typeof newAsyncContext>>
	bindings: QuickJsBindings
	disposableHandles: QuickJSHandle[]
}): void {
	for (const [name, fn] of Object.entries(input.bindings)) {
		const handle = input.context.newAsyncifiedFunction(name, async (...args) => {
			const output = await fn(...args.map((arg) => input.context.dump(arg)))
			return input.context.newString(JSON.stringify(output ?? null))
		})
		input.context.setProp(input.context.global, name, handle)
		input.disposableHandles.push(handle)
	}
	installBindingFacade(input.context, input.disposableHandles)
}

function installBindingFacade(vm: QuickJSContext, disposableHandles: QuickJSHandle[]): void {
	const result = vm.evalCode(`
		globalThis.bindings = new Proxy({}, {
			get(_target, prop) {
				return (...args) => {
					const raw = globalThis[prop](...args)
					return typeof raw === 'string' ? JSON.parse(raw) : raw
				}
			}
		})
	`)
	const value = vm.unwrapResult(result)
	disposableHandles.push(value)
}

function disposeHandles(handles: QuickJSHandle[]): void {
	for (const handle of handles) handle.dispose()
}
