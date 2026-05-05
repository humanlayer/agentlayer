import { getQuickJS, newAsyncContext, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten'

export type QuickJsBinding = (...args: unknown[]) => unknown | Promise<unknown>
export type QuickJsBindings = Record<string, QuickJsBinding>

export type QuickJsExecutionMode = 'sync' | 'async'

export type QuickJsConsoleLevel = 'log' | 'info' | 'warn' | 'error'

export type QuickJsConsoleEntry = {
	level: QuickJsConsoleLevel
	args: unknown[]
	text: string
}

export type QuickJsExecutionErrorDetails = {
	name?: string
	message: string
	fileName?: string
	lineNumber?: number
	columnNumber?: number
	codeFrame?: string
}

export class QuickJsExecutionError extends Error {
	readonly details: QuickJsExecutionErrorDetails

	constructor(
		details: QuickJsExecutionErrorDetails,
		options?: {
			cause?: unknown
		},
	) {
		super(formatQuickJsExecutionMessage(details))
		this.name = 'QuickJsExecutionError'
		this.details = details
		if (options && 'cause' in options) {
			Object.defineProperty(this, 'cause', {
				value: options.cause,
				configurable: true,
				writable: true,
			})
		}
	}
}

export type QuickJsSerializedError = {
	name?: string
	message: string
	fileName?: string
	lineNumber?: number
	columnNumber?: number
	codeFrame?: string
}

export type QuickJsRunWithConsoleResult<T = unknown> =
	| {
			ok: true
			value: T
			console: QuickJsConsoleEntry[]
	  }
	| {
			ok: false
			error: QuickJsSerializedError
			console: QuickJsConsoleEntry[]
	  }

export type QuickJsExec = {
	readonly mode: QuickJsExecutionMode
	run<T = unknown>(code: string): T | Promise<T>
	dispose(): void
}

export type QuickJsSyncExec = QuickJsExec & {
	readonly mode: 'sync'
	run<T = unknown>(code: string): T
	runWithConsole<T = unknown>(code: string): QuickJsRunWithConsoleResult<T>
}

export type QuickJsAsyncExec = QuickJsExec & {
	readonly mode: 'async'
	run<T = unknown>(code: string): Promise<T>
	runWithConsole<T = unknown>(code: string): Promise<QuickJsRunWithConsoleResult<T>>
}

export type WithQuickJsModeCallback<T> = (exec: QuickJsSyncExec) => T
export type WithAsyncQuickJsModeCallback<T> = (exec: QuickJsAsyncExec) => Promise<T>

export async function withQuickJsMode<T>(bindings: QuickJsBindings, cb: WithQuickJsModeCallback<T>): Promise<T> {
	const QuickJS = await getQuickJS()
	const vm = QuickJS.newContext()
	const disposableHandles: QuickJSHandle[] = []

	try {
		installSyncBindings({ vm, bindings, disposableHandles })
		return cb({
			mode: 'sync',
			run: (code) => runSync<TypedUnknown>(vm, code) as never,
			runWithConsole: (code) => runSyncWithConsole<TypedUnknown>(vm, code) as never,
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
			runWithConsole: (code) => runAsyncWithConsole<TypedUnknown>(context, code) as never,
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
	const value = unwrapQuickJsResult(vm, result, code)
	try {
		return vm.dump(value) as T
	} finally {
		value.dispose()
	}
}

async function runAsync<T>(context: Awaited<ReturnType<typeof newAsyncContext>>, code: string): Promise<T> {
	const result = await context.evalCodeAsync(code)
	const value = unwrapQuickJsResult(context, result, code)
	try {
		return context.dump(value) as T
	} finally {
		value.dispose()
	}
}

function runSyncWithConsole<T>(vm: QuickJSContext, code: string): QuickJsRunWithConsoleResult<T> {
	clearConsole(vm)
	try {
		const value = runSync<T>(vm, code)
		return { ok: true, value, console: readConsole(vm) }
	} catch (error) {
		return { ok: false, error: serializeError(error), console: readConsole(vm) }
	}
}

async function runAsyncWithConsole<T>(
	context: Awaited<ReturnType<typeof newAsyncContext>>,
	code: string,
): Promise<QuickJsRunWithConsoleResult<T>> {
	clearConsole(context)
	try {
		const value = await runAsync<T>(context, code)
		return { ok: true, value, console: readConsole(context) }
	} catch (error) {
		return { ok: false, error: serializeError(error), console: readConsole(context) }
	}
}

function unwrapQuickJsResult(
	context: QuickJSContext | Awaited<ReturnType<typeof newAsyncContext>>,
	result: unknown,
	code: string,
): QuickJSHandle {
	try {
		return context.unwrapResult(result as never) as QuickJSHandle
	} catch (error) {
		throw createQuickJsExecutionError(error, code)
	}
}

function createQuickJsExecutionError(error: unknown, code: string): QuickJsExecutionError {
	const cause = error && typeof error === 'object' && 'cause' in error ? (error as { cause?: unknown }).cause : error
	const causeRecord = cause && typeof cause === 'object' ? (cause as Record<string, unknown>) : undefined
	const name = typeof causeRecord?.name === 'string' ? causeRecord.name : error instanceof Error ? error.name : undefined
	const message = typeof causeRecord?.message === 'string' ? causeRecord.message : error instanceof Error ? error.message : String(error)
	const fileName = typeof causeRecord?.fileName === 'string' ? causeRecord.fileName : undefined
	const lineNumber = typeof causeRecord?.lineNumber === 'number' ? causeRecord.lineNumber : undefined
	const columnNumber = typeof causeRecord?.columnNumber === 'number' ? causeRecord.columnNumber : undefined

	return new QuickJsExecutionError(
		{
			name,
			message,
			fileName,
			lineNumber,
			columnNumber,
			codeFrame: lineNumber ? formatCodeFrame(code, lineNumber, columnNumber) : undefined,
		},
		{ cause },
	)
}

function serializeError(error: unknown): QuickJsSerializedError {
	if (error instanceof QuickJsExecutionError) return error.details
	if (error instanceof Error) return { name: error.name, message: error.message }
	return { message: String(error) }
}

function formatQuickJsExecutionMessage(details: QuickJsExecutionErrorDetails): string {
	const location = details.lineNumber
		? `${details.fileName ?? 'eval.js'}:${details.lineNumber}${details.columnNumber ? `:${details.columnNumber}` : ''}`
		: undefined
	const headline = [details.name, details.message].filter(Boolean).join(': ')
	return [location ? `${headline} at ${location}` : headline, details.codeFrame].filter(Boolean).join('\n')
}

function formatCodeFrame(code: string, lineNumber: number, columnNumber?: number): string {
	const lines = code.replace(/^\n/, '').split('\n')
	const normalizedLineNumber = Math.max(1, Math.min(lineNumber, lines.length))
	const start = Math.max(1, normalizedLineNumber - 2)
	const end = Math.min(lines.length, normalizedLineNumber + 2)
	const width = String(end).length
	const frame: string[] = []

	for (let line = start; line <= end; line++) {
		const marker = line === normalizedLineNumber ? '>' : ' '
		const source = lines[line - 1] ?? ''
		frame.push(`${marker} ${String(line).padStart(width, ' ')} | ${source}`)
		if (line === normalizedLineNumber && columnNumber && columnNumber > 0) {
			frame.push(`  ${' '.repeat(width)} | ${' '.repeat(columnNumber - 1)}^`)
		}
	}

	return frame.join('\n')
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
		globalThis.__quickjsConsoleLogs = []
		function __quickjsConsoleText(args) {
			return args.map((arg) => {
				if (typeof arg === 'string') return arg
				try { return JSON.stringify(arg) }
				catch { return String(arg) }
			}).join(' ')
		}
		function __quickjsConsolePush(level, args) {
			globalThis.__quickjsConsoleLogs.push({
				level,
				args,
				text: __quickjsConsoleText(args),
			})
		}
		globalThis.console = {
			log: (...args) => __quickjsConsolePush('log', args),
			info: (...args) => __quickjsConsolePush('info', args),
			warn: (...args) => __quickjsConsolePush('warn', args),
			error: (...args) => __quickjsConsolePush('error', args),
		}
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

function clearConsole(vm: QuickJSContext | Awaited<ReturnType<typeof newAsyncContext>>): void {
	const result = vm.evalCode('globalThis.__quickjsConsoleLogs.length = 0')
	const value = vm.unwrapResult(result)
	value.dispose()
}

function readConsole(vm: QuickJSContext | Awaited<ReturnType<typeof newAsyncContext>>): QuickJsConsoleEntry[] {
	const result = vm.evalCode('globalThis.__quickjsConsoleLogs')
	const value = vm.unwrapResult(result)
	try {
		return vm.dump(value) as QuickJsConsoleEntry[]
	} finally {
		value.dispose()
	}
}

function disposeHandles(handles: QuickJSHandle[]): void {
	for (const handle of handles) handle.dispose()
}
