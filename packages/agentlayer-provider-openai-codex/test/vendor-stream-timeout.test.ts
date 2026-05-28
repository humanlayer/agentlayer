// @ts-nocheck
import { describe, expect, test } from 'bun:test'
import { Endpoint, LLMClient, Protocol, RequestExecutor, Route } from '@humanlayer/opencode-llm-vendor/route'
import { LLMRequest } from '@humanlayer/opencode-llm-vendor/schema'
import { Effect, Layer, Schema, Stream } from 'effect'

const testProtocol = Protocol.make({
	id: 'test-protocol',
	body: {
		schema: Schema.Struct({}),
		from: () => Effect.succeed({}),
	},
	stream: {
		event: Schema.Struct({
			type: Schema.String,
			text: Schema.optional(Schema.String),
		}),
		initial: () => ({}),
		step: (state, event) =>
			Effect.succeed([
				state,
				event.type === 'delta' ? [{ type: 'text-delta', id: 'text-0', text: event.text ?? '' }] : [],
			]),
		terminal: (event) => event.type === 'done',
	},
})

const unusedRequestExecutorLayer = Layer.succeed(
	RequestExecutor.Service,
	RequestExecutor.Service.of({
		execute: () => Effect.die('test transport should not use RequestExecutor'),
	}),
)

const clientLayer = LLMClient.layer.pipe(Layer.provide(unusedRequestExecutorLayer))

function createRequest(
	frames: (attempt: number) => Stream.Stream<unknown, never>,
	streamOptions: Record<string, number>,
) {
	let attempts = 0
	const transport = {
		id: 'test-transport',
		prepare: () => Effect.succeed({}),
		frames: () => {
			attempts += 1
			return frames(attempts)
		},
	}
	const route = Route.make({
		id: 'test-route',
		provider: 'test-provider',
		protocol: testProtocol,
		endpoint: Endpoint.path('/responses', { baseURL: 'https://example.test' }),
		transport,
		defaults: { stream: streamOptions },
	})
	const request = new LLMRequest({
		model: route.model({ id: 'test-model' }),
		system: [],
		messages: [],
		tools: [],
	})
	return { request, attempts: () => attempts }
}

const runEvents = (request: LLMRequest) =>
	Effect.runPromise(Stream.runCollect(Stream.provide(LLMClient.stream(request), clientLayer)))

describe('vendored LLMClient protocol-event idle timeout', () => {
	test('retries first-event timeouts with bounded backoff', async () => {
		const { request, attempts } = createRequest(
			(attempt) =>
				attempt <= 3 ? Stream.never : Stream.make({ type: 'delta', text: 'ok after retry' }, { type: 'done' }),
			{
				firstEventTimeoutMs: 10,
				firstEventTimeoutRetries: 3,
				firstEventRetryBaseDelayMs: 1,
				firstEventRetryMaxDelayMs: 1,
				eventIdleTimeoutMs: 50,
			},
		)

		const events = Array.from(await runEvents(request))

		expect(attempts()).toBe(4)
		expect(events).toContainEqual({ type: 'text-delta', id: 'text-0', text: 'ok after retry' })
	})

	test('stops after the configured first-event retry budget', async () => {
		const { request, attempts } = createRequest(() => Stream.never, {
			firstEventTimeoutMs: 10,
			firstEventTimeoutRetries: 3,
			firstEventRetryBaseDelayMs: 1,
			firstEventRetryMaxDelayMs: 1,
		})

		let error: unknown
		try {
			await runEvents(request)
		} catch (err) {
			error = err
		}

		expect(attempts()).toBe(4)
		expect((error as { reason?: { kind?: string } }).reason?.kind).toBe('ProtocolFirstEventTimeout')
	})

	test('does not retry idle timeouts after the first protocol event', async () => {
		const { request, attempts } = createRequest(() => Stream.concat(Stream.make({ type: 'noop' }), Stream.never), {
			firstEventTimeoutMs: 10,
			firstEventTimeoutRetries: 3,
			firstEventRetryBaseDelayMs: 1,
			firstEventRetryMaxDelayMs: 1,
			eventIdleTimeoutMs: 10,
		})

		let error: unknown
		try {
			await runEvents(request)
		} catch (err) {
			error = err
		}

		expect(attempts()).toBe(1)
		expect((error as { reason?: { kind?: string } }).reason?.kind).toBe('ProtocolEventIdleTimeout')
	})
})
