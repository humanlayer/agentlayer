// @ts-nocheck — vendored from opencode, tested upstream under different tsconfig
import { Cause, Context, Effect, Layer, Random, Schema, Sink, Stream } from 'effect'
import * as Option from 'effect/Option'
import { applyCachePolicy } from '../cache-policy'
import * as ProviderShared from '../protocols/shared'
import type { LLMError, LLMEvent, PreparedRequestOf, ProtocolID, ProviderOptions } from '../schema'
import {
	GenerationOptions,
	HttpOptions,
	LLMError as LLMErrorClass,
	LLMRequest,
	LLMResponse,
	Model,
	ModelLimits,
	mergeGenerationOptions,
	mergeHttpOptions,
	mergeProviderOptions,
	mergeStreamOptions,
	PreparedRequest,
	ProviderID,
	StreamOptions,
	TransportReason,
} from '../schema'
import type { Tools } from '../tool'
import * as ToolRuntime from '../tool-runtime'
import { Auth, type Auth as AuthDef } from './auth'
import {
	type Interface as DiagnosticsInterface,
	LLMDiagnostics,
	llmErrorMetadata,
	noopDiagnostics,
} from './diagnostics'
import { Endpoint, type EndpointPatch } from './endpoint'
import { RequestExecutor } from './executor'
import type { Framing } from './framing'
import type { Protocol } from './protocol'
import type { Transport, TransportRuntime } from './transport'
import { HttpTransport, WebSocketExecutor } from './transport'

export interface RouteBody<Body> {
	/** Schema for the validated provider-native body sent as the JSON request. */
	readonly schema: Schema.Codec<Body, unknown>
	/** Build the provider-native body from a common `LLMRequest`. */
	readonly from: (request: LLMRequest) => Effect.Effect<Body, LLMError>
}

export interface Route<Body, Prepared = unknown> {
	readonly id: string
	readonly provider?: ProviderID
	readonly protocol: ProtocolID
	readonly endpoint: Endpoint<Body>
	readonly auth: AuthDef
	readonly transport: Transport<Body, Prepared, unknown>
	readonly defaults: RouteDefaults
	readonly body: RouteBody<Body>
	readonly with: (patch: RoutePatch<Body, Prepared>) => Route<Body, Prepared>
	readonly model: (input: RouteMappedModelInput) => Model
	readonly prepareTransport: (body: Body, request: LLMRequest) => Effect.Effect<Prepared, LLMError>
	readonly streamPrepared: (
		prepared: Prepared,
		request: LLMRequest,
		runtime: TransportRuntime,
	) => Stream.Stream<LLMEvent, LLMError>
}

// Route registries intentionally erase body generics after construction.
// Normal call sites use `OpenAIChat.route`; callers only need body types
// when preparing a request with a protocol-specific type assertion.
// oxlint-disable-next-line typescript-eslint/no-explicit-any
export type AnyRoute = Route<any, any>

export type HttpOptionsInput = HttpOptions.Input

export type RouteModelInput = Omit<Model.Input, 'provider' | 'route'>

export type RouteRoutedModelInput = Omit<Model.Input, 'route'>

export interface RouteDefaults {
	readonly headers?: Record<string, string>
	readonly limits?: ModelLimits
	readonly generation?: GenerationOptions
	readonly providerOptions?: ProviderOptions
	readonly http?: HttpOptions
	readonly stream?: StreamOptions
}

export interface RouteDefaultsInput {
	readonly headers?: Record<string, string>
	readonly limits?: ModelLimits.Input
	readonly generation?: GenerationOptions.Input
	readonly providerOptions?: ProviderOptions
	readonly http?: HttpOptions.Input
	readonly stream?: StreamOptions.Input
}

export interface RoutePatch<Body, Prepared> extends RouteDefaultsInput {
	readonly id?: string
	readonly provider?: string | ProviderID
	readonly auth?: AuthDef
	readonly transport?: Transport<Body, Prepared, unknown>
	readonly endpoint?: EndpointPatch<Body>
}

type RouteMappedModelInput = RouteModelInput | RouteRoutedModelInput

const makeRouteModel = (route: AnyRoute, mapped: RouteMappedModelInput) => {
	const provider = route.provider ?? ('provider' in mapped ? mapped.provider : undefined)
	if (!provider) throw new Error(`Route.model(${route.id}) requires a provider`)
	if (!endpointBaseURL(route.endpoint))
		throw new Error(`Route.model(${route.id}) requires an endpoint baseURL — configure it on the route first`)
	return Model.make({
		...mapped,
		provider,
		route,
	})
}

const mergeRouteDefaults = (base: RouteDefaults | undefined, patch: RouteDefaultsInput): RouteDefaults => {
	const headers = mergeHeaders(base?.headers, patch.headers)
	return {
		...base,
		...patch,
		headers,
		limits: patch.limits === undefined ? base?.limits : ModelLimits.make(patch.limits),
		generation: mergeGenerationOptions(generationOptions(base?.generation), generationOptions(patch.generation)),
		providerOptions: mergeProviderOptions(base?.providerOptions, patch.providerOptions),
		http: mergeHttpOptions(
			base?.http,
			httpOptions(patch.http),
			headers === undefined ? undefined : new HttpOptions({ headers }),
		),
		stream: mergeStreamOptions(base?.stream, streamOptions(patch.stream)),
	}
}

const endpointBaseURL = <Body>(endpoint: Endpoint<Body>) =>
	typeof endpoint.baseURL === 'string' ? endpoint.baseURL : undefined

const mergeHeaders = (...items: ReadonlyArray<Record<string, string> | undefined>) => {
	const entries = items.flatMap((item) =>
		item === undefined
			? []
			: Object.entries(item).filter((entry): entry is [string, string] => entry[1] !== undefined),
	)
	if (entries.length === 0) return undefined
	return Object.fromEntries(entries)
}

export const generationOptions = (input: GenerationOptions.Input | undefined) =>
	input === undefined ? undefined : GenerationOptions.make(input)

export const httpOptions = (input: HttpOptionsInput | undefined) => {
	if (input === undefined) return input
	return HttpOptions.make(input)
}

export const streamOptions = (input: StreamOptions.Input | undefined) => {
	if (input === undefined) return input
	return StreamOptions.make(input)
}

export interface Interface {
	/**
	 * Compile a request through protocol body construction, validation, and HTTP
	 * preparation without sending it. Returns the prepared request including the
	 * provider-native body.
	 *
	 * Pass a `Body` type argument to statically expose the route's body
	 * shape (e.g. `prepare<OpenAIChatBody>(...)`) — the runtime body is
	 * identical, so this is a type-level assertion the caller makes about which
	 * route the request will resolve to.
	 */
	readonly prepare: <Body = unknown>(request: LLMRequest) => Effect.Effect<PreparedRequestOf<Body>, LLMError>
	readonly stream: StreamMethod
	readonly generate: GenerateMethod
}

export interface StreamMethod {
	(request: LLMRequest): Stream.Stream<LLMEvent, LLMError>
	<T extends Tools>(options: ToolRuntime.RunOptions<T>): Stream.Stream<LLMEvent, LLMError>
}

export interface GenerateMethod {
	(request: LLMRequest): Effect.Effect<LLMResponse, LLMError>
	<T extends Tools>(options: ToolRuntime.RunOptions<T>): Effect.Effect<LLMResponse, LLMError>
}

export class Service extends Context.Service<Service, Interface>()('@opencode/LLMClient') {}

const resolveRequestOptions = (request: LLMRequest) =>
	LLMRequest.update(request, {
		generation:
			mergeGenerationOptions(request.model.route.defaults.generation, request.generation) ??
			new GenerationOptions({}),
		providerOptions: mergeProviderOptions(request.model.route.defaults.providerOptions, request.providerOptions),
		http: mergeHttpOptions(request.model.route.defaults.http, request.http),
		stream: mergeStreamOptions(request.model.route.defaults.stream, request.stream),
	})

export interface MakeInput<Body, Frame, Event, State> {
	/** Route id used in diagnostics and prepared request metadata. */
	readonly id: string
	/** Provider identity for route-owned model construction. */
	readonly provider?: string | ProviderID
	/** Semantic API contract — owns body construction, body schema, and parsing. */
	readonly protocol: Protocol<Body, Frame, Event, State>
	/** Where the request is sent. */
	readonly endpoint: Endpoint<Body>
	/** Per-request transport auth. Provider facades override this via `route.with(...)`. */
	readonly auth?: AuthDef
	/** Stream framing — bytes -> frames before `protocol.stream.event` decoding. */
	readonly framing: Framing<Frame>
	/** Static / per-request headers added before `auth` runs. */
	readonly headers?: (input: { readonly request: LLMRequest }) => Record<string, string>
	/** Route/request defaults used when compiling requests for this route. */
	readonly defaults?: RouteDefaultsInput
}

export interface MakeTransportInput<Body, Prepared, Frame, Event, State> {
	/** Route id used in diagnostics and prepared request metadata. */
	readonly id: string
	/** Provider identity for route-owned model construction. */
	readonly provider?: string | ProviderID
	/** Semantic API contract — owns body construction, body schema, and parsing. */
	readonly protocol: Protocol<Body, Frame, Event, State>
	/** Where the request is sent. */
	readonly endpoint: Endpoint<Body>
	/** Per-request transport auth. Provider facades override this via `route.with(...)`. */
	readonly auth?: AuthDef
	/** Static / per-request headers added before `auth` runs. */
	readonly headers?: (input: { readonly request: LLMRequest }) => Record<string, string>
	/** Runnable transport route. */
	readonly transport: Transport<Body, Prepared, Frame>
	/** Route/request defaults used when compiling requests for this route. */
	readonly defaults?: RouteDefaultsInput
}

const streamError = (route: string, message: string, cause: Cause.Cause<unknown>) => {
	const failed = cause.reasons.find(Cause.isFailReason)?.error
	if (failed instanceof LLMErrorClass) return failed
	return ProviderShared.eventError(route, message, Cause.pretty(cause))
}

const resolveDiagnostics = (runtime: TransportRuntime): DiagnosticsInterface => runtime.diagnostics ?? noopDiagnostics

const FIRST_EVENT_TIMEOUT_KIND = 'ProtocolFirstEventTimeout'
const EVENT_IDLE_TIMEOUT_KIND = 'ProtocolEventIdleTimeout'
const DEFAULT_FIRST_EVENT_RETRY_BASE_DELAY_MS = 1_000
const DEFAULT_FIRST_EVENT_RETRY_MAX_DELAY_MS = 10_000

const positiveNumber = (value: number | undefined) =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

const nonNegativeInteger = (value: number | undefined) =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0

const durationMs = (value: number) => `${Math.round(value)} millis`

const protocolEventTimeoutError = (route: string, kind: string, timeoutMs: number) =>
	new LLMErrorClass({
		module: 'LLMClient',
		method: 'stream',
		reason: new TransportReason({
			message: `No provider protocol event received for ${timeoutMs}ms while streaming ${route}`,
			kind,
		}),
	})

const isFirstEventTimeout = (error: LLMError) =>
	error instanceof LLMErrorClass &&
	error.reason?._tag === 'Transport' &&
	error.reason?.kind === FIRST_EVENT_TIMEOUT_KIND

const withEventIdleTimeout = <A>(
	stream: Stream.Stream<A, LLMError>,
	route: string,
	timeoutMs: number | undefined,
	diagnostics: DiagnosticsInterface = noopDiagnostics,
) => {
	const idleTimeoutMs = positiveNumber(timeoutMs)
	if (!idleTimeoutMs) return stream
	return stream.pipe(
		Stream.timeoutOrElse({
			duration: durationMs(idleTimeoutMs),
			orElse: () => {
				const error = protocolEventTimeoutError(route, EVENT_IDLE_TIMEOUT_KIND, idleTimeoutMs)
				return Stream.unwrap(
					diagnostics
						.error('codex.provider.timeout.event_idle', {
							route,
							terminal: true,
							timeoutMs: idleTimeoutMs,
							...llmErrorMetadata(error),
						})
						.pipe(Effect.as(Stream.fail(error))),
				)
			},
		}),
	)
}

const withProtocolEventTimeouts = <A>(
	stream: Stream.Stream<A, LLMError>,
	route: string,
	request: LLMRequest,
	diagnostics: DiagnosticsInterface = noopDiagnostics,
): Stream.Stream<A, LLMError> => {
	const firstTimeoutMs = positiveNumber(request.stream?.firstEventTimeoutMs)
	const idleTimeoutMs = positiveNumber(request.stream?.eventIdleTimeoutMs)
	if (!firstTimeoutMs) return withEventIdleTimeout(stream, route, idleTimeoutMs, diagnostics)

	return Stream.unwrap(
		Effect.gen(function* () {
			const [first, rest] = yield* Stream.peel(stream, Sink.head()).pipe(
				Effect.timeoutOrElse({
					duration: durationMs(firstTimeoutMs),
					orElse: () =>
						Effect.fail(protocolEventTimeoutError(route, FIRST_EVENT_TIMEOUT_KIND, firstTimeoutMs)),
				}),
			)
			if (Option.isNone(first)) return Stream.empty
			return Stream.concat(
				Stream.make(first.value),
				withEventIdleTimeout(rest, route, idleTimeoutMs, diagnostics),
			)
		}),
	)
}

const firstEventRetryDelay = (options: StreamOptions, attempt: number) => {
	const baseDelayMs = positiveNumber(options.firstEventRetryBaseDelayMs) ?? DEFAULT_FIRST_EVENT_RETRY_BASE_DELAY_MS
	const maxDelayMs = positiveNumber(options.firstEventRetryMaxDelayMs) ?? DEFAULT_FIRST_EVENT_RETRY_MAX_DELAY_MS
	const target = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs)
	return Random.nextBetween(Math.min(target * 0.8, maxDelayMs), Math.min(target * 1.2, maxDelayMs)).pipe(
		Effect.map((delay) => Math.round(delay)),
	)
}

const retryFirstEventTimeout = <A>(
	makeStream: () => Stream.Stream<A, LLMError>,
	options: StreamOptions | undefined,
	diagnostics: DiagnosticsInterface = noopDiagnostics,
	attempt = 0,
): Stream.Stream<A, LLMError> => {
	const retries = nonNegativeInteger(options?.firstEventTimeoutRetries)
	if (retries <= 0) return makeStream()
	return makeStream().pipe(
		Stream.catchTag('LLM.Error', (error) => {
			if (!isFirstEventTimeout(error) || attempt >= retries) {
				// Terminal: retry budget exhausted or non-retryable error
				if (isFirstEventTimeout(error) && attempt >= retries) {
					return Stream.unwrap(
						diagnostics
							.error('codex.provider.timeout.first_event.exhausted', {
								terminal: true,
								attempt: attempt + 1,
								maxRetries: retries,
								...llmErrorMetadata(error),
							})
							.pipe(Effect.as(Stream.fail(error))),
					)
				}
				return Stream.fail(error)
			}
			return Stream.unwrap(
				diagnostics
					.warning('codex.provider.timeout.first_event.retry', {
						terminal: false,
						attempt: attempt + 1,
						maxRetries: retries,
						...llmErrorMetadata(error),
					})
					.pipe(
						Effect.flatMap(() => firstEventRetryDelay(options!, attempt)),
						Effect.flatMap((delay) =>
							diagnostics
								.info('codex.provider.timeout.first_event.retry_scheduled', {
									attempt: attempt + 1,
									delayMs: delay,
								})
								.pipe(Effect.as(delay)),
						),
						Effect.flatMap((delay) => Effect.sleep(durationMs(delay))),
						Effect.map(() => retryFirstEventTimeout(makeStream, options, diagnostics, attempt + 1)),
					),
			)
		}),
	)
}

function makeFromTransport<Body, Prepared, Frame, Event, State>(
	input: MakeTransportInput<Body, Prepared, Frame, Event, State>,
): Route<Body, Prepared> {
	const protocol = input.protocol
	const encodeBody = Schema.encodeSync(Schema.fromJsonString(protocol.body.schema))
	const decodeEventEffect = Schema.decodeUnknownEffect(protocol.stream.event)
	const decodeEvent = (route: string) => (frame: Frame) =>
		decodeEventEffect(frame).pipe(
			Effect.mapError(() =>
				ProviderShared.eventError(
					input.id,
					`Invalid ${route} stream event`,
					typeof frame === 'string' ? frame : ProviderShared.encodeJson(frame),
				),
			),
		)

	type BuiltRouteInput = Omit<MakeTransportInput<Body, Prepared, Frame, Event, State>, 'defaults'> & {
		readonly defaults?: RouteDefaults
	}

	const build = (routeInput: BuiltRouteInput): Route<Body, Prepared> => {
		const route: Route<Body, Prepared> = {
			id: routeInput.id,
			provider: routeInput.provider === undefined ? undefined : ProviderID.make(routeInput.provider),
			protocol: protocol.id,
			endpoint: routeInput.endpoint,
			auth: routeInput.auth ?? Auth.none,
			transport: routeInput.transport,
			defaults: routeInput.defaults ?? {},
			body: protocol.body,
			with: (patch: RoutePatch<Body, Prepared>) => {
				const { id, provider, auth, transport, endpoint, ...defaults } = patch
				return build({
					...routeInput,
					id: id ?? routeInput.id,
					provider: provider ?? routeInput.provider,
					auth: auth ?? routeInput.auth,
					endpoint: endpoint ? Endpoint.merge(routeInput.endpoint, endpoint) : routeInput.endpoint,
					transport: (transport as Transport<Body, Prepared, Frame> | undefined) ?? routeInput.transport,
					defaults: mergeRouteDefaults(route.defaults, defaults),
				})
			},
			model: (input) => makeRouteModel(route, input),
			prepareTransport: (body, request) =>
				routeInput.transport.prepare({
					body,
					request,
					endpoint: routeInput.endpoint,
					auth: routeInput.auth ?? Auth.none,
					encodeBody,
					headers: routeInput.headers,
				}),
			streamPrepared: (prepared: Prepared, request: LLMRequest, runtime: TransportRuntime) => {
				const route = `${request.model.provider}/${request.model.route.id}`
				const diagnostics = resolveDiagnostics(runtime)
				const decodedEvents = routeInput.transport
					.frames(prepared, request, runtime)
					.pipe(
						Stream.mapEffect(decodeEvent(route)),
						protocol.stream.terminal ? Stream.takeUntil(protocol.stream.terminal) : (stream) => stream,
					)
				const events = withProtocolEventTimeouts(decodedEvents, route, request, diagnostics)
				return events.pipe(
					Stream.mapAccumEffect(
						() => protocol.stream.initial(request),
						protocol.stream.step,
						protocol.stream.onHalt ? { onHalt: protocol.stream.onHalt } : undefined,
					),
					Stream.catchCause((cause) => {
						const error = streamError(route, `Failed to read ${route} stream`, cause)
						return Stream.unwrap(
							diagnostics
								.error('codex.provider.stream.failed', {
									route,
									terminal: true,
									...llmErrorMetadata(error),
								})
								.pipe(Effect.as(Stream.fail(error))),
						)
					}),
				)
			},
		} satisfies Route<Body, Prepared>
		return route
	}

	return build({ ...input, defaults: mergeRouteDefaults(undefined, input.defaults ?? {}) })
}

export function make<Body, Prepared, Frame, Event, State>(
	input: MakeTransportInput<Body, Prepared, Frame, Event, State>,
): Route<Body, Prepared>
/**
 * Build a `Route` by composing the four orthogonal pieces of a deployment:
 *
 * - `Protocol` — what is the API I'm speaking?
 * - `Endpoint` — where do I send the request?
 * - `Auth` — how do I authenticate it?
 * - `Framing` — how do I cut the response stream into protocol frames?
 *
 * Plus optional `headers` for cross-cutting deployment concerns (provider
 * version pins, per-deployment quirks).
 *
 * This is the canonical route constructor. If a new route does not fit
 * this four-axis model, add a purpose-built constructor rather than widening
 * the public surface preemptively.
 */
export function make<Body, Frame, Event, State>(
	input: MakeInput<Body, Frame, Event, State>,
): Route<Body, HttpTransport.HttpPrepared<Frame>>
export function make<Body, Prepared, Frame, Event, State>(
	input: MakeInput<Body, Frame, Event, State> | MakeTransportInput<Body, Prepared, Frame, Event, State>,
): Route<Body, Prepared> | Route<Body, HttpTransport.HttpPrepared<Frame>> {
	if ('transport' in input) return makeFromTransport(input)
	const protocol = input.protocol
	return makeFromTransport({
		id: input.id,
		provider: input.provider,
		protocol,
		endpoint: input.endpoint,
		auth: input.auth,
		headers: input.headers,
		transport: HttpTransport.httpJson({ framing: input.framing }),
		defaults: input.defaults,
	})
}

// `compile` is the important boundary: it turns a common `LLMRequest` into a
// validated provider body plus transport-private prepared data, but does not
// execute transport.
const compile = Effect.fn('LLM.compile')(function* (request: LLMRequest) {
	const resolved = applyCachePolicy(resolveRequestOptions(request))
	const route = resolved.model.route

	const body = yield* route.body
		.from(resolved)
		.pipe(Effect.flatMap(ProviderShared.validateWith(Schema.decodeUnknownEffect(route.body.schema))))
	const prepared = yield* route.prepareTransport(body, resolved)

	return {
		request: resolved,
		route,
		body,
		prepared,
	}
})

const prepareWith = Effect.fn('LLMClient.prepare')(function* (request: LLMRequest) {
	const compiled = yield* compile(request)

	return new PreparedRequest({
		id: compiled.request.id ?? 'request',
		route: compiled.route.id,
		protocol: compiled.route.protocol,
		model: compiled.request.model,
		body: compiled.body,
		metadata: { transport: compiled.route.transport.id },
	})
})

const streamRequestWith = (runtime: TransportRuntime) => (request: LLMRequest) => {
	const options = mergeStreamOptions(request.model.route.defaults.stream, request.stream)
	const diagnostics = resolveDiagnostics(runtime)
	return retryFirstEventTimeout(
		() =>
			Stream.unwrap(
				Effect.gen(function* () {
					const compiled = yield* compile(request)
					return compiled.route.streamPrepared(compiled.prepared, compiled.request, runtime)
				}),
			),
		options,
		diagnostics,
	)
}

const isToolRunOptions = (input: LLMRequest | ToolRuntime.RunOptions<Tools>): input is ToolRuntime.RunOptions<Tools> =>
	'request' in input && 'tools' in input

const streamWith = (streamRequest: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>): StreamMethod =>
	((input: LLMRequest | ToolRuntime.RunOptions<Tools>) => {
		if (isToolRunOptions(input)) return ToolRuntime.stream({ ...input, stream: streamRequest })
		return streamRequest(input)
	}) as StreamMethod

const generateWith = (stream: Interface['stream']) =>
	Effect.fn('LLM.generate')(function* (input: LLMRequest | ToolRuntime.RunOptions<Tools>) {
		return new LLMResponse(
			yield* stream(input as never).pipe(
				Stream.runFold(
					() => ({ events: [] as LLMEvent[], usage: undefined as LLMResponse['usage'] }),
					(acc, event) => {
						acc.events.push(event)
						if ('usage' in event && event.usage !== undefined) acc.usage = event.usage
						return acc
					},
				),
			),
		)
	})

export const prepare = <Body = unknown>(request: LLMRequest) =>
	prepareWith(request) as Effect.Effect<PreparedRequestOf<Body>, LLMError>

export function stream(request: LLMRequest): Stream.Stream<LLMEvent, LLMError>
export function stream<T extends Tools>(options: ToolRuntime.RunOptions<T>): Stream.Stream<LLMEvent, LLMError>
export function stream(input: LLMRequest | ToolRuntime.RunOptions<Tools>) {
	return Stream.unwrap(
		Effect.gen(function* () {
			return (yield* Service).stream(input as never)
		}),
	)
}

export function generate(request: LLMRequest): Effect.Effect<LLMResponse, LLMError>
export function generate<T extends Tools>(options: ToolRuntime.RunOptions<T>): Effect.Effect<LLMResponse, LLMError>
export function generate(input: LLMRequest | ToolRuntime.RunOptions<Tools>) {
	return Effect.gen(function* () {
		return yield* (yield* Service).generate(input as never)
	})
}

export const streamRequest = (request: LLMRequest) =>
	Stream.unwrap(
		Effect.gen(function* () {
			return (yield* Service).stream(request)
		}),
	)

export const layer: Layer.Layer<Service, never, RequestExecutor.Service> = Layer.effect(
	Service,
	Effect.gen(function* () {
		const stream = streamWith(
			streamRequestWith({
				http: yield* RequestExecutor.Service,
				webSocket: Option.getOrUndefined(yield* Effect.serviceOption(WebSocketExecutor.Service)),
				// Resolved optionally (precedent: `WebSocketExecutor` above) so the
				// public requirement type of `layer` stays `RequestExecutor.Service`
				// only. Falls back to a no-op sink at the call sites when absent.
				diagnostics: Option.getOrUndefined(yield* Effect.serviceOption(LLMDiagnostics.Service)),
			}),
		)
		return Service.of({ prepare: prepareWith as Interface['prepare'], stream, generate: generateWith(stream) })
	}),
)

// Re-export from diagnostics.ts for backward compatibility with Phase 1 callers
export { llmErrorMetadata } from './diagnostics'

export const Route = { make } as const

export const LLMClient = {
	Service,
	layer,
	prepare,
	stream,
	generate,
	stepCountIs: ToolRuntime.stepCountIs,
} as const
