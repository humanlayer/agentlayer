import { Effect, Stream } from 'effect'
import { Headers, HttpClientError, type HttpClientRequest } from 'effect/unstable/http'
import * as ProviderShared from '../../protocols/shared'
import { LLMError, TransportReason } from '../../schema'
import type { LLMRequest } from '../../schema'
import { mergeJsonRecords } from '../../schema'
import { Auth } from '../auth'
import { render as renderEndpoint } from '../endpoint'
import { Framing, type Framing as FramingDef } from '../framing'
import type { Transport, TransportPrepareInput } from './index'

export type JsonRequestInput<Body> = TransportPrepareInput<Body>

export interface JsonRequestParts<Body = unknown> {
	readonly url: string
	readonly jsonBody: Body | Record<string, unknown>
	readonly bodyText: string
	readonly headers: Headers.Headers
}

export interface HttpPrepared<Frame> {
	readonly request: HttpClientRequest.HttpClientRequest
	readonly framing: FramingDef<Frame>
}

const applyQuery = (url: string, query: Record<string, string> | undefined) => {
	if (!query) return url
	const next = new URL(url)
	Object.entries(query).forEach(([key, value]) => next.searchParams.set(key, value))
	return next.toString()
}

const bodyWithOverlay = <Body>(body: Body, request: LLMRequest, encodeBody: (body: Body) => string) =>
	Effect.gen(function* () {
		if (request.http?.body === undefined) return { jsonBody: body, bodyText: encodeBody(body) }
		if (ProviderShared.isRecord(body)) {
			const overlaid = mergeJsonRecords(body, request.http.body) ?? {}
			return { jsonBody: overlaid, bodyText: ProviderShared.encodeJson(overlaid) }
		}
		return yield* ProviderShared.invalidRequest('http.body can only overlay JSON object request bodies')
	})

export const jsonRequestParts = <Body>(input: JsonRequestInput<Body>) =>
	Effect.gen(function* () {
		const url = applyQuery(
			renderEndpoint(input.endpoint, { request: input.request, body: input.body }).toString(),
			input.request.http?.query,
		)
		const body = yield* bodyWithOverlay(input.body, input.request, input.encodeBody)
		const headers = yield* Auth.toEffect(input.auth)({
			request: input.request,
			method: 'POST',
			url,
			body: body.bodyText,
			headers: Headers.fromInput({
				...input.headers?.({ request: input.request }),
				...input.request.http?.headers,
			}),
		})
		return { url, jsonBody: body.jsonBody, bodyText: body.bodyText, headers }
	})

export interface HttpJsonInput<_Body, Frame> {
	readonly framing: FramingDef<Frame>
}

export type HttpJsonPatch<Body, Frame> = Partial<HttpJsonInput<Body, Frame>>

export interface HttpJsonTransport<Body, Frame> extends Transport<Body, HttpPrepared<Frame>, Frame> {
	readonly with: (patch: HttpJsonPatch<Body, Frame>) => HttpJsonTransport<Body, Frame>
}

const isTransportError = (error: unknown): boolean => {
	if (error instanceof Error) {
		const msg = error.message.toLowerCase()
		if (
			msg.includes('socket') ||
			msg.includes('econnreset') ||
			msg.includes('econnrefused') ||
			msg.includes('epipe') ||
			msg.includes('etimedout') ||
			msg.includes('network') ||
			msg.includes('aborted') ||
			msg.includes('closed unexpectedly') ||
			msg.includes('connection') ||
			msg.includes('fetch failed')
		)
			return true
	}
	if (HttpClientError.isHttpClientError(error)) return true
	return false
}

const streamReadError = (route: string, error: unknown): LLMError => {
	const message = `Failed to read ${route} stream: ${ProviderShared.errorText(error)}`
	if (isTransportError(error)) {
		return new LLMError({
			module: 'ProviderShared',
			method: 'stream',
			reason: new TransportReason({
				message,
				kind: 'StreamRead',
			}),
		})
	}
	return ProviderShared.eventError(route, message, ProviderShared.errorText(error))
}

export const httpJson = <Body, Frame>(input: HttpJsonInput<Body, Frame>): HttpJsonTransport<Body, Frame> => ({
	id: 'http-json',
	with: (patch) => httpJson({ ...input, ...patch }),
	prepare: (prepareInput) =>
		jsonRequestParts({
			...prepareInput,
		}).pipe(
			Effect.map((parts) => ({
				request: ProviderShared.jsonPost({ url: parts.url, body: parts.bodyText, headers: parts.headers }),
				framing: input.framing,
			})),
		),
	frames: (prepared, request, runtime) =>
		Stream.unwrap(
			runtime.http
				.execute(prepared.request)
				.pipe(
					Effect.map((response) =>
						prepared.framing.frame(
							response.stream.pipe(
								Stream.mapError((error) =>
									streamReadError(
										`${request.model.provider}/${request.model.route.id}`,
										error,
									),
								),
							),
						),
					),
				),
		),
})

export const sseJson = {
	id: 'http-json/sse',
	with: <Body>() => httpJson<Body, string>({ framing: Framing.sse }),
} as const
