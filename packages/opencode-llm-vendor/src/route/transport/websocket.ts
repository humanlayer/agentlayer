// @ts-nocheck — vendored from opencode, tested upstream under different tsconfig
import { Cause, Context, Effect, Layer, Queue, Schedule, Stream } from 'effect'
import type { Headers } from 'effect/unstable/http'
import { LLMError, TransportReason } from '../../schema'
import * as HttpTransport from './http'
import type { Transport } from './index'

const DEBUG = process.env.DEBUG_CODEX_WS === '1'
const dbg = (...args: unknown[]) => {
	if (DEBUG) console.error('[ws-transport]', ...args)
}

// Global connection tracking — tells us exactly how many are open when a 101 fires
let _openConns = 0
let _totalOpened = 0
let _totalClosed = 0
let _totalFailed = 0
const connState = () => `open=${_openConns} opened=${_totalOpened} closed=${_totalClosed} failed=${_totalFailed}`

export interface WebSocketRequest {
	readonly url: string
	readonly headers: Headers.Headers
}

export interface WebSocketConnection {
	readonly sendText: (message: string) => Effect.Effect<void, LLMError>
	readonly messages: Stream.Stream<string | Uint8Array, LLMError>
	readonly close: Effect.Effect<void, never>
}

export interface Interface {
	readonly open: (input: WebSocketRequest) => Effect.Effect<WebSocketConnection, LLMError>
}

type WebSocketConstructorWithHeaders = new (
	url: string,
	options?: { readonly headers?: Headers.Headers },
) => globalThis.WebSocket

export class Service extends Context.Service<Service, Interface>()('@opencode/LLM/WebSocketExecutor') {}

const transportError = (
	method: string,
	message: string,
	input: { readonly url?: string; readonly kind?: string } = {},
) =>
	new LLMError({
		module: 'WebSocketExecutor',
		method,
		reason: new TransportReason({ message, url: input.url, kind: input.kind }),
	})

const eventMessage = (event: Event) => {
	if ('message' in event && typeof event.message === 'string') return event.message
	return event.type
}

const binaryMessage = (data: unknown) => {
	if (data instanceof Uint8Array) return data
	if (data instanceof ArrayBuffer) return new Uint8Array(data)
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
	return undefined
}

const waitOpen = (ws: globalThis.WebSocket, input: WebSocketRequest) => {
	dbg('waitOpen: readyState=', ws.readyState, connState())
	if (ws.readyState === globalThis.WebSocket.OPEN) {
		_openConns++
		_totalOpened++
		dbg('waitOpen: already open,', connState())
		return Effect.void
	}
	if (ws.readyState === globalThis.WebSocket.CLOSING || ws.readyState === globalThis.WebSocket.CLOSED) {
		return Effect.fail(
			transportError('open', `WebSocket closed before opening (state ${ws.readyState})`, {
				url: input.url,
				kind: 'open',
			}),
		)
	}
	return Effect.callback<void, LLMError>((resume, signal) => {
		const cleanup = () => {
			ws.removeEventListener('open', onOpen)
			ws.removeEventListener('error', onError)
			ws.removeEventListener('close', onClose)
			signal.removeEventListener('abort', onAbort)
		}
		const onAbort = () => {
			cleanup()
			if (ws.readyState !== globalThis.WebSocket.CLOSED && ws.readyState !== globalThis.WebSocket.CLOSING)
				ws.close(1000)
		}
		const onOpen = () => {
			cleanup()
			_openConns++
			_totalOpened++
			dbg('waitOpen: connected,', connState())
			resume(Effect.void)
		}
		const onError = (event: Event) => {
			cleanup()
			_totalFailed++
			dbg('waitOpen: FAILED,', connState(), eventMessage(event))
			resume(
				Effect.fail(
					transportError('open', `Failed to open WebSocket: ${eventMessage(event)}`, {
						url: input.url,
						kind: 'open',
					}),
				),
			)
		}
		const onClose = (event: CloseEvent) => {
			cleanup()
			resume(
				Effect.fail(
					transportError('open', `WebSocket closed before opening with code ${event.code}`, {
						url: input.url,
						kind: 'open',
					}),
				),
			)
		}
		ws.addEventListener('open', onOpen, { once: true })
		ws.addEventListener('error', onError, { once: true })
		ws.addEventListener('close', onClose, { once: true })
		signal.addEventListener('abort', onAbort, { once: true })
	})
}

const webSocketUrl = (value: string) =>
	Effect.try({
		try: () => {
			const url = new URL(value)
			if (url.protocol === 'https:') {
				url.protocol = 'wss:'
				return url.toString()
			}
			if (url.protocol === 'http:') {
				url.protocol = 'ws:'
				return url.toString()
			}
			throw new Error(`Unsupported WebSocket URL protocol ${url.protocol}`)
		},
		catch: (error) =>
			transportError('prepare', error instanceof Error ? error.message : 'Invalid WebSocket URL', {
				url: value,
				kind: 'websocket',
			}),
	})

export const open = (input: WebSocketRequest) =>
	Effect.try({
		try: () =>
			new (globalThis.WebSocket as unknown as WebSocketConstructorWithHeaders)(input.url, {
				headers: input.headers,
			}),
		catch: (error) =>
			transportError('open', error instanceof Error ? error.message : 'Failed to construct WebSocket', {
				url: input.url,
				kind: 'open',
			}),
	}).pipe(Effect.flatMap((ws) => fromWebSocket(ws, input)))

export const layer: Layer.Layer<Service> = Layer.succeed(Service, Service.of({ open }))

export const fromWebSocket = (
	ws: globalThis.WebSocket,
	input: WebSocketRequest,
): Effect.Effect<WebSocketConnection, LLMError> =>
	Effect.gen(function* () {
		yield* waitOpen(ws, input)
		const messages = yield* Queue.bounded<string | Uint8Array, LLMError | Cause.Done<void>>(128)

		const onMessage = (event: MessageEvent) => {
			if (typeof event.data === 'string') {
				const preview = event.data.length > 120 ? `${event.data.substring(0, 120)}...` : event.data
				dbg('msg:', preview)
				return Queue.offerUnsafe(messages, event.data)
			}
			const binary = binaryMessage(event.data)
			if (binary) return Queue.offerUnsafe(messages, binary)
			Queue.failCauseUnsafe(
				messages,
				Cause.fail(
					transportError('message', 'Unsupported WebSocket message payload', {
						url: input.url,
						kind: 'message',
					}),
				),
			)
		}
		const onError = (event: Event) => {
			dbg('ws onerror:', eventMessage(event))
			Queue.failCauseUnsafe(
				messages,
				Cause.fail(
					transportError('message', `WebSocket error: ${eventMessage(event)}`, {
						url: input.url,
						kind: 'message',
					}),
				),
			)
		}
		const onClose = (event: CloseEvent) => {
			dbg('ws onclose: code=', event.code, 'reason=', event.reason)
			if (event.code === 1000 || event.code === 1005) return Queue.endUnsafe(messages)
			Queue.failCauseUnsafe(
				messages,
				Cause.fail(
					transportError('message', `WebSocket closed with code ${event.code}`, {
						url: input.url,
						kind: 'close',
					}),
				),
			)
		}
		const cleanup = Effect.sync(() => {
			_openConns--
			_totalClosed++
			dbg('cleanup: readyState=', ws.readyState, connState())
			ws.removeEventListener('message', onMessage)
			ws.removeEventListener('error', onError)
			ws.removeEventListener('close', onClose)
		}).pipe(Effect.andThen(Queue.shutdown(messages)))

		ws.addEventListener('message', onMessage)
		ws.addEventListener('error', onError)
		ws.addEventListener('close', onClose)

		return {
			sendText: (message) =>
				Effect.try({
					try: () => ws.send(message),
					catch: (error) =>
						transportError(
							'sendText',
							error instanceof Error ? error.message : 'Failed to send WebSocket message',
							{
								url: input.url,
								kind: 'write',
							},
						),
				}),
			messages: Stream.fromQueue(messages),
			close: cleanup.pipe(
				Effect.andThen(
					Effect.sync(() => {
						if (
							ws.readyState === globalThis.WebSocket.CLOSED ||
							ws.readyState === globalThis.WebSocket.CLOSING
						)
							return
						ws.close(1000)
					}),
				),
			),
		}
	})

export const messageText = (message: string | Uint8Array, decoder: TextDecoder) =>
	typeof message === 'string' ? message : decoder.decode(message)

export interface JsonPrepared {
	readonly url: string
	readonly headers: Headers.Headers
	readonly message: string
}

export interface JsonInput<Body, Message> {
	readonly toMessage: (body: Body | Record<string, unknown>) => Effect.Effect<Message, LLMError>
	readonly encodeMessage: (message: Message) => string
}

export type JsonPatch<Body, Message> = Partial<JsonInput<Body, Message>>

export interface JsonTransport<Body, Message> extends Transport<Body, JsonPrepared, string> {
	readonly with: (patch: JsonPatch<Body, Message>) => JsonTransport<Body, Message>
}

export const json = <Body, Message>(input: JsonInput<Body, Message>): JsonTransport<Body, Message> => ({
	id: 'websocket-json',
	with: (patch) => json({ ...input, ...patch }),
	prepare: (prepareInput) =>
		Effect.gen(function* () {
			const parts = yield* HttpTransport.jsonRequestParts({
				...prepareInput,
			})
			return {
				url: yield* webSocketUrl(parts.url),
				headers: parts.headers,
				message: input.encodeMessage(yield* input.toMessage(parts.jsonBody)),
			}
		}),
	frames: (prepared, _request, runtime) => {
		const webSocket = runtime.webSocket
		if (!webSocket) {
			return Stream.fail(
				transportError('json', 'WebSocket JSON transport requires WebSocketExecutor.Service', {
					url: prepared.url,
					kind: 'websocket',
				}),
			)
		}
		const decoder = new TextDecoder()
		const openAndStream = Effect.gen(function* () {
			dbg('frames: opening WS to', prepared.url)
			const connection = yield* Effect.acquireRelease(
				webSocket.open({ url: prepared.url, headers: prepared.headers }),
				(connection) => {
					dbg('frames: acquireRelease finalizer — closing WS')
					return connection.close
				},
			)
			dbg('frames: WS open, sending message')
			yield* connection.sendText(prepared.message)
			dbg('frames: message sent, returning message stream')
			return connection.messages.pipe(Stream.map((message) => messageText(message, decoder)))
		})
		const withRetry = openAndStream.pipe(
			Effect.tapError((error) =>
				Effect.sync(() =>
					dbg(
						'frames: WS open failed, will retry if transport error.',
						connState(),
						error.reason._tag,
						error.reason.message,
					),
				),
			),
			Effect.retry({
				schedule: Schedule.both(Schedule.jittered(Schedule.exponential('1 seconds')), Schedule.recurs(6)),
				while: (error: LLMError) => error.reason._tag === 'Transport',
			}),
			Effect.tapError((error) =>
				Effect.sync(() => dbg('frames: all retries exhausted,', connState(), error.reason.message)),
			),
		)
		return Stream.unwrap(withRetry)
	},
})

export const jsonTransport = {
	id: 'websocket-json',
	with: json,
} as const

export const WebSocketExecutor = {
	Service,
	layer,
	open,
	fromWebSocket,
	messageText,
} as const

export const WebSocketTransport = {
	json,
	jsonTransport,
} as const
